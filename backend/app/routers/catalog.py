"""Browse endpoints: the service catalogue and the Tier 2 institution directory."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..ai.assembler import _institution_out, build_contract
from ..db import get_db
from ..models import Institution, Service
from ..schemas import AnswerContract, InstitutionOut

router = APIRouter(tags=["catalog"])


@router.get("/services")
def list_services(category: str | None = None, db: Session = Depends(get_db)) -> list[dict]:
    query = db.query(Service)
    if category:
        query = query.filter(Service.category == category)
    services = query.order_by(Service.category, Service.name).all()
    out = []
    for service in services:
        inst = db.get(Institution, service.institution_id)
        out.append(
            {
                "id": service.id,
                "name": service.name,
                "short_name": service.short_name,
                "category": service.category,
                "summary": service.summary,
                "coverage_tier": service.coverage_tier,
                "institution": {
                    "id": inst.id if inst else "",
                    "name": inst.name if inst else "",
                    "abbreviation": inst.abbreviation if inst else "",
                },
                "step_count": len(service.steps or []),
                "document_count": len(service.documents or []),
                "reviewed": service.reviewed_at is not None,
            }
        )
    return out


@router.get("/services/{service_id}", response_model=AnswerContract)
def get_service(service_id: str, db: Session = Depends(get_db)) -> AnswerContract:
    """The full service card, assembled and validated exactly as the ask
    endpoint would produce it — so a deep link is never less trustworthy
    than an answer."""
    service = db.get(Service, service_id)
    if service is None:
        raise HTTPException(404, "We do not have a service card with that id.")
    return build_contract(db, service)


@router.get("/institutions", response_model=list[InstitutionOut])
def list_institutions(db: Session = Depends(get_db)) -> list[InstitutionOut]:
    institutions = db.query(Institution).order_by(Institution.coverage_tier, Institution.name).all()
    return [_institution_out(i) for i in institutions]


@router.get("/institutions/{institution_id}")
def get_institution(institution_id: str, db: Session = Depends(get_db)) -> dict:
    inst = db.get(Institution, institution_id)
    if inst is None:
        raise HTTPException(404, "We do not have a directory entry for that institution.")
    services = db.query(Service).filter(Service.institution_id == institution_id).all()
    return {
        "institution": _institution_out(inst),
        "notes": inst.notes or "",
        "services": [
            {"id": s.id, "name": s.name, "short_name": s.short_name, "summary": s.summary}
            for s in services
        ],
    }


@router.get("/categories")
def list_categories(db: Session = Depends(get_db)) -> list[dict]:
    rows = db.query(Service.category).distinct().all()
    labels = {
        "business": "Business and trade",
        "tax": "Tax",
        "identity": "Identity",
        "travel": "Travel and passports",
        "vehicles": "Driving and vehicles",
        "health": "Health",
        "civil": "Civil records",
        "property": "Land and building",
        "justice": "Police and justice",
    }
    return sorted(
        ({"id": r[0], "label": labels.get(r[0], r[0].title())} for r in rows),
        key=lambda c: c["label"],
    )
