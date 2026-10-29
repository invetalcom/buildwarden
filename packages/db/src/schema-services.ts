// Provider sessions, remote access, orchestration, and usage tables.
export const SERVICES_SCHEMA_SQL = `      create table if not exists provider_session_runtime (
        owner_id text not null,
        owner_kind text not null,
        provider_type text not null,
        harness_type text not null,
        status text not null,
        cwd text not null,
        model_id text,
        runtime_mode text not null,
        resume_cursor_json text,
        runtime_payload_json text,
        last_seen_at text not null,
        created_at text not null,
        updated_at text not null,
        primary key (owner_id, owner_kind)
      );
      create index if not exists idx_provider_session_runtime_last_seen on provider_session_runtime(last_seen_at);

      create table if not exists remote_pairing_grants (
        id text primary key,
        token_hash text not null unique,
        scopes_json text not null,
        expires_at text not null,
        used_at text,
        created_at text not null,
        client_origin text
      );

      create table if not exists remote_access_sessions (
        id text primary key,
        token_hash text not null unique,
        label text not null,
        scopes_json text not null,
        created_at text not null,
        expires_at text not null,
        last_used_at text not null,
        revoked_at text,
        client_origin text
      );

      create table if not exists remote_security_audit (
        id text primary key,
        event text not null,
        outcome text not null,
        session_id text,
        pairing_grant_id text,
        remote_address text,
        details_json text,
        created_at text not null
      );

      create table if not exists remote_command_idempotency (
        session_id text not null,
        idempotency_key text not null,
        method text not null,
        request_hash text not null,
        response_json text,
        created_at text not null,
        completed_at text,
        primary key (session_id, idempotency_key)
      );

      create index if not exists idx_remote_pairing_grants_expiry on remote_pairing_grants(expires_at);
      create index if not exists idx_remote_access_sessions_token on remote_access_sessions(token_hash);
      create index if not exists idx_remote_access_sessions_created on remote_access_sessions(created_at desc);
      create index if not exists idx_remote_security_audit_created on remote_security_audit(created_at desc);
      create index if not exists idx_remote_command_idempotency_created on remote_command_idempotency(created_at desc);

      create table if not exists orchestrations (
        id text primary key,
        project_id text not null,
        coordinator_run_id text not null unique,
        status text not null,
        team_snapshot_json text not null,
        wake_mode text,
        wake_task_ids_json text not null default '[]',
        last_event_sequence integer not null default 0,
        last_delivered_sequence integer not null default 0,
        error_message text,
        created_at text not null,
        updated_at text not null,
        finished_at text
      );

      create table if not exists orchestration_waves (
        id text primary key,
        orchestration_id text not null,
        wave_index integer not null,
        baseline_path text,
        baseline_state text not null default 'capturing',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists orchestration_tasks (
        id text primary key,
        orchestration_id text not null,
        wave_id text not null,
        client_task_id text not null,
        title text not null,
        prompt text not null,
        role_id text not null,
        model_id text not null,
        intent text not null,
        status text not null,
        child_run_id text unique,
        retry_of_task_id text,
        summary text,
        error_message text,
        attention_reason text,
        adoption_status text not null default 'none',
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        unique(orchestration_id, client_task_id)
      );

      create table if not exists orchestration_events (
        id text primary key,
        orchestration_id text not null,
        task_id text,
        sequence integer not null,
        type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        unique(orchestration_id, sequence)
      );

      create table if not exists orchestration_task_messages (
        id text primary key,
        orchestration_id text not null,
        task_id text not null,
        source text not null,
        content text not null,
        status text not null default 'queued',
        created_at text not null,
        delivered_at text
      );

      create table if not exists orchestration_operations (
        id text primary key,
        orchestration_id text not null,
        request_id text not null,
        tool_name text not null,
        request_hash text not null,
        status text not null,
        response_json text,
        error_message text,
        created_at text not null,
        updated_at text not null,
        unique(orchestration_id, request_id)
      );

      create table if not exists orchestration_cleanup_jobs (
        id text primary key,
        coordinator_run_id text not null,
        orchestration_id text,
        manifest_json text not null,
        status text not null,
        error_message text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists orchestration_adoptions (
        id text primary key,
        orchestration_id text not null,
        task_id text not null,
        status text not null,
        manifest_json text not null default '{}',
        backup_path text,
        error_message text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists app_token_usage (
        scope text primary key,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0
      );

      create table if not exists token_usage_events (
        id text primary key,
        project_id text,
        owner_kind text not null,
        owner_id text not null,
        input_tokens integer not null,
        output_tokens integer not null,
        created_at text not null
      );

      create index if not exists idx_orchestrations_project on orchestrations(project_id, updated_at desc);
      create index if not exists idx_orchestrations_status on orchestrations(status);
      create unique index if not exists idx_orchestration_waves_number on orchestration_waves(orchestration_id, wave_index);
      create index if not exists idx_orchestration_tasks_status on orchestration_tasks(orchestration_id, status);
      create index if not exists idx_orchestration_tasks_child_run on orchestration_tasks(child_run_id);
      create index if not exists idx_orchestration_tasks_model_id on orchestration_tasks(model_id);
      create index if not exists idx_orchestration_events_sequence on orchestration_events(orchestration_id, sequence);
      create index if not exists idx_orchestration_messages_status on orchestration_task_messages(task_id, status);
      create index if not exists idx_orchestration_cleanup_status on orchestration_cleanup_jobs(status, updated_at);
      create index if not exists idx_forge_requests_project on forge_requests(project_id, updated_at desc);
      create index if not exists idx_run_forge_links_request on run_forge_links(forge_request_id);
      create index if not exists idx_token_usage_events_created on token_usage_events(created_at);
      create index if not exists idx_token_usage_events_project on token_usage_events(project_id, created_at);
    `;
