/** Mirrors the backend Answer Contract in app/schemas.py. */

export type FieldStatus =
  | 'confirmed'
  | 'secondary'
  | 'not_published'
  | 'varies_by_locality'
  | 'disputed';

export type Outcome = 'answered' | 'clarify' | 'refused' | 'blocked';
export type Confidence = 'high' | 'medium' | 'low';
export type Freshness = 'fresh' | 'verify' | 'stale';

export interface SourceRef {
  id: string;
  title: string;
  publisher: string;
  url: string;
  is_official: boolean;
  retrieved_at: string | null;
  effective_date: string | null;
  note: string;
}

export interface Institution {
  id: string;
  name: string;
  abbreviation: string;
  mandate: string;
  official_url: string;
  portal_url: string;
  phone: string;
  email: string;
  head_office: string;
  digital_address: string;
  opening_hours: string;
  offices: string[];
  coverage_tier: number;
}

export interface EligibilityItem {
  text: string;
  applies_to: string;
  status: FieldStatus;
  source_ref: string | null;
}

export interface DocumentItem {
  name: string;
  mandatory: boolean;
  where_to_obtain: string;
  note: string;
  one_of_group: string | null;
  status: FieldStatus;
  source_ref: string | null;
}

export interface StepItem {
  order: number;
  action: string;
  channel: 'online' | 'in_person' | 'either' | 'phone' | 'ussd';
  location: string;
  note: string;
  status: FieldStatus;
  source_ref: string | null;
}

export interface FeeItem {
  label: string;
  amount_ghs: number | null;
  amount_text: string | null;
  effective_date: string | null;
  status: FieldStatus;
  note: string;
  source_ref: string | null;
}

export interface Timeline {
  standard: string | null;
  expedited: string | null;
  status: FieldStatus;
  note: string;
  source_ref: string | null;
}

export interface RejectionCause {
  text: string;
  evidence_level: 'official' | 'secondary' | 'inferred';
  source_ref: string | null;
}

export interface RelatedService {
  id: string;
  name: string;
  institution: string;
  reason: string;
}

export interface Caveat {
  kind: 'freshness' | 'coverage' | 'eligibility' | 'dispute' | 'locality' | 'scope';
  text: string;
}

export interface ValidatorReport {
  fields_checked: number;
  fields_dropped: number;
  dropped: string[];
  unsourced_claims: number;
  strict_fields_ok: boolean;
  notes: string[];
}

export type DirectAnswerVerdict = 'addressed' | 'partly_addressed' | 'not_addressed';

export interface DirectAnswer {
  question_understood: string;
  verdict: DirectAnswerVerdict;
  text: string;
  source_ids: string[];
}

export interface Assumption {
  id: string;
  value: string;
  /** The chosen option in words, e.g. "Outside Ghana". */
  label: string;
  /** The question it stands in for, so the person sees what was decided. */
  question: string;
  /** Read from their own words, or simply the usual case. */
  origin: 'question' | 'default';
}

export interface AnswerContract {
  outcome: Outcome;
  intent: string | null;
  service_id: string | null;
  service_name: string | null;
  summary: string;
  coverage_tier: number | null;
  confidence: Confidence;
  freshness: Freshness;
  direct_answer: DirectAnswer | null;
  assumptions: Assumption[];
  institution: Institution | null;
  dependent_institutions: Institution[];
  eligibility: EligibilityItem[];
  documents: DocumentItem[];
  steps: StepItem[];
  fees: FeeItem[];
  timeline: Timeline | null;
  common_rejection_causes: RejectionCause[];
  related_services: RelatedService[];
  sources: SourceRef[];
  caveats: Caveat[];
  last_reviewed_by_team: string | null;
  content_version: number;
  generated_by: string;
  prompt_version: string;
  validator: ValidatorReport;
}

export interface ClarifyOption {
  value: string;
  label: string;
  hint: string;
}

export interface ClarifyQuestion {
  id: string;
  question: string;
  options: ClarifyOption[];
  allow_skip: boolean;
}

export interface CandidateService {
  id: string;
  name: string;
  institution: string;
  score: number;
  summary: string;
}

export interface TraceStage {
  stage: string;
  detail: string;
  [key: string]: unknown;
}

export interface QueryResponse {
  query_id: string;
  answer_id: string | null;
  session_id: string;
  outcome: Outcome;
  contract: AnswerContract | null;
  clarify: ClarifyQuestion | null;
  service_id: string | null;
  service_name: string | null;
  candidates: CandidateService[];
  message: string;
  suggested_institution: Institution | null;
  latency_ms: number;
  stages: TraceStage[];
}

export interface ServiceSummary {
  id: string;
  name: string;
  short_name: string;
  category: string;
  summary: string;
  coverage_tier: number;
  institution: { id: string; name: string; abbreviation: string };
  step_count: number;
  document_count: number;
  reviewed: boolean;
}

export interface Category {
  id: string;
  label: string;
}

export interface SystemInfo {
  app: string;
  env: string;
  llm_provider: string;
  llm_model: string;
  llm_mode: string;
  embedder: string;
  embedding_dim: number;
  prompt_version: string;
  database: string;
  services_indexed: number;
  relevance_floor: number;
}

export interface SavedChecklist {
  id: string;
  service_id: string;
  title: string;
  payload: Record<string, unknown>;
  progress: Record<string, boolean>;
  updated_at: string;
}
