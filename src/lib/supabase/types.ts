/**
 * Hand-maintained mirror of supabase/migrations. Regenerate against a live
 * project with:
 *   npx supabase gen types typescript --project-id <id> > src/lib/supabase/types.ts
 */

import type { Confidence, ItemStatus, ItemType, JobStatus } from '@/lib/types';

export type UploadStatus = 'pending' | 'parsed' | 'failed' | 'skipped';

export type UserRow = {
  id: string;
  email: string | null;
  plan: string;
  feed_token: string;
  created_at: string;
  updated_at: string;
};

export type TermRow = {
  id: string;
  user_id: string;
  name: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
};

export type CourseRow = {
  id: string;
  user_id: string;
  term_id: string;
  code: string;
  name: string | null;
  color: string;
  meeting_days: number[];
  position: number;
  created_at: string;
  updated_at: string;
};

export type ItemRow = {
  id: string;
  user_id: string;
  term_id: string;
  course_id: string;
  title: string;
  type: ItemType;
  due_date: string | null;
  due_time: string | null;
  time_is_default: boolean;
  weight: number | null;
  location: string | null;
  source_snippet: string;
  source_upload_id: string | null;
  confidence: Confidence;
  status: ItemStatus;
  dedupe_key: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type UploadRow = {
  id: string;
  user_id: string;
  job_id: string | null;
  storage_path: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  status: UploadStatus;
  error_message: string | null;
  extracted_text: string | null;
  text_purged_at: string | null;
  purge_after: string;
  created_at: string;
};

export type ExtractionJobRow = {
  id: string;
  user_id: string;
  term_id: string | null;
  status: JobStatus;
  total_files: number;
  processed_files: number;
  file_errors: { filename: string; reason: string }[];
  error_message: string | null;
  item_count: number;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type CalendarConnectionRow = {
  id: string;
  user_id: string;
  provider: string;
  google_account_email: string | null;
  google_calendar_id: string | null;
  calendar_name: string | null;
  scope: string | null;
  refresh_token_encrypted: string;
  access_token_encrypted: string | null;
  access_token_expires_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanLimitsRow = {
  plan: string;
  monthly_extractions: number;
  max_files_per_batch: number;
  max_file_bytes: number;
  max_pdf_pages: number;
  extractions_per_hour: number;
  max_input_chars: number;
};

export type UsageEventRow = {
  id: number;
  user_id: string | null;
  job_id: string | null;
  kind: 'extraction' | 'demo_extraction' | 'export_ics' | 'gcal_sync';
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  files_count: number;
  chunks_count: number;
  duration_ms: number | null;
  succeeded: boolean;
  created_at: string;
};

// postgrest-js requires `Relationships` on every table for the schema to
// satisfy GenericSchema; without it the typed client silently degrades and
// every .rpc() argument resolves to `undefined`.
type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      users: Table<UserRow>;
      terms: Table<TermRow>;
      courses: Table<CourseRow>;
      items: Table<ItemRow>;
      uploads: Table<UploadRow>;
      extraction_jobs: Table<ExtractionJobRow>;
      calendar_connections: Table<CalendarConnectionRow>;
      plan_limits: Table<PlanLimitsRow>;
      usage_events: Table<UsageEventRow>;
    };
    Views: Record<string, never>;
    Functions: {
      consume_extraction_quota: { Args: { p_user_id: string; p_files: number }; Returns: unknown };
      get_quota_status: { Args: { p_user_id: string }; Returns: unknown };
      consume_rate_limit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      purge_user_data: { Args: { p_user_id: string }; Returns: unknown };
      purge_job_text: { Args: { p_job_id: string }; Returns: number };
      list_expired_uploads: { Args: { p_limit: number }; Returns: unknown };
      delete_purged_uploads: { Args: { p_ids: string[] }; Returns: number };
      rotate_feed_token: { Args: Record<string, never>; Returns: string };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
