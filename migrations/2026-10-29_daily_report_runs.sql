-- Build A (daily report), 6.7 and 7: one row per daily report run.
--
-- Used for:
-- - "Already sent today": every run that isn't forced looks for a row with
--   the same report_date and git_ref and status sent / sent_with_failures.
--   If one exists it records itself as 'skipped' and exits. On main that
--   covers the Supabase-triggered dispatch and the 9 AM backup schedule;
--   branch test runs only ever match their own branch's rows.
-- - Activity window: since the last sent run on main (24 hours if none).
-- - "Yesterday's report didn't run": no sent / sent_with_failures row on
--   main for yesterday. A row left in 'running' counts as not run.
--
-- Written only by the report with the service role key. RLS on, no
-- policies, so signed-in portal users can neither read nor write it.

create table public.daily_report_runs (
  id            bigint generated always as identity primary key,
  report_date   date not null,                 -- Arizona date
  git_ref       text not null,                 -- GITHUB_REF, e.g. refs/heads/main
  trigger_event text,                          -- GITHUB_EVENT_NAME: workflow_dispatch / schedule
  forced        boolean not null default false, -- workflow_dispatch input "force": skipped the check
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                check (status in ('running', 'sent', 'sent_with_failures', 'failed', 'skipped')),
  failures      jsonb not null default '[]'::jsonb,
  resend_id     text,
  github_run_id text
);

create index daily_report_runs_ref_date on public.daily_report_runs (git_ref, report_date);

alter table public.daily_report_runs enable row level security;
