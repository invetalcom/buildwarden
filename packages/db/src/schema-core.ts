// Core project, run, chat, and automation tables. Keep creation order stable.
export const CORE_SCHEMA_SQL = `
      create table if not exists projects (
        id text primary key,
        name text not null,
        repo_path text not null unique,
        default_branch text not null,
        project_kind text not null default 'git',
        cumulative_input_tokens integer not null default 0,
        cumulative_output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        last_opened_at text
      );

      create table if not exists provider_accounts (
        id text primary key,
        provider_type text not null,
        label text not null,
        api_base_url text,
        api_key_ref text not null,
        config_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists models (
        id text primary key,
        provider_account_id text not null,
        model_id text not null,
        display_name text not null,
        base_url_override text,
        config_json text not null default '{}',
        capabilities_json text not null default '{}',
        enabled integer not null default 1,
        created_at text not null,
        updated_at text not null,
        foreign key(provider_account_id) references provider_accounts(id)
      );

      create table if not exists runs (
        id text primary key,
        project_id text not null,
        provider_account_id text not null,
        model_id text not null,
        harness_type text not null,
        run_mode text not null default 'code',
        workspace_type text not null default 'worktree',
        workspace_vcs text not null default 'git',
        prompt text not null,
        goal_text text,
        status text not null,
        branch_name text not null,
        worktree_path text not null,
        summary text,
        error_message text,
        last_provider_response_id text,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        list_visibility text not null default 'default',
        run_kind text not null default 'standard',
        lab_thread_id text,
        parent_run_id text,
        root_run_id text,
        lineage_title text,
        project_task_id text,
        automation_id text,
        delegation_enabled integer not null default 0,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        foreign key(project_id) references projects(id),
        foreign key(provider_account_id) references provider_accounts(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists run_workspace_setup (
        run_id text primary key references runs(id) on delete cascade,
        profile_json text not null,
        status text not null
      );

      create table if not exists run_steps (
        id text primary key,
        run_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(run_id) references runs(id)
      );

      create table if not exists attention_acknowledgements (
        item_id text primary key,
        run_id text not null,
        acknowledged_at text not null
      );
      create index if not exists idx_attention_acknowledgements_run on attention_acknowledgements(run_id);

      create table if not exists attention_suppression_windows (
        id integer primary key,
        kind text not null,
        started_at text not null,
        ended_at text
      );
      create index if not exists idx_attention_suppression_kind on attention_suppression_windows(kind, started_at);

      create table if not exists run_notes (
        id text primary key,
        run_id text not null,
        content text not null,
        status text not null default 'open',
        created_at text not null,
        updated_at text not null,
        closed_at text,
        foreign key(run_id) references runs(id)
      );

      create table if not exists forge_requests (
        id text primary key,
        project_id text not null,
        provider text not null,
        request_number integer not null,
        summary_json text not null,
        details_json text,
        checks_json text not null default '[]',
        etag text,
        last_modified text,
        last_synced_at text not null,
        error_count integer not null default 0,
        sync_error text,
        retry_after_at text,
        created_at text not null,
        updated_at text not null,
        unique(project_id, provider, request_number),
        foreign key(project_id) references projects(id)
      );

      create table if not exists run_verifications (
        run_id text primary key,
        evidence text not null
      );

      create table if not exists run_forge_links (
        run_id text primary key,
        forge_request_id text,
        branch_name text not null,
        head_sha text,
        last_probe_at text,
        negative_cache_until text,
        error_count integer not null default 0,
        sync_error text,
        retry_after_at text,
        created_at text not null,
        updated_at text not null,
        foreign key(run_id) references runs(id),
        foreign key(forge_request_id) references forge_requests(id)
      );

      create table if not exists worktrees (
        id text primary key,
        project_id text not null,
        run_id text not null,
        branch_name text not null,
        worktree_path text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(run_id) references runs(id)
      );

      create table if not exists app_settings (
        key text primary key,
        value text not null,
        updated_at text not null
      );

      create table if not exists run_restore_points (
        run_id text primary key,
        command_type text not null,
        patch text not null,
        head_sha text,
        created_at text not null
      );

      create table if not exists bookmarks (
        id text primary key,
        original_run_id text not null,
        project_id text,
        project_name text not null,
        prompt text not null,
        status text not null,
        branch_name text not null,
        model_id text,
        run_created_at text not null,
        bookmarked_at text not null
      );

      create table if not exists bookmark_steps (
        id text primary key,
        bookmark_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key (bookmark_id) references bookmarks(id)
      );

      create table if not exists chats (
        id text primary key,
        provider_account_id text not null,
        model_id text not null,
        run_id text,
        prompt text not null,
        status text not null,
        last_provider_response_id text,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        foreign key(provider_account_id) references provider_accounts(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists chat_steps (
        id text primary key,
        chat_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(chat_id) references chats(id)
      );

      create table if not exists chat_bookmarks (
        id text primary key,
        original_chat_id text not null,
        prompt text not null,
        status text not null,
        model_id text,
        chat_created_at text not null,
        bookmarked_at text not null
      );

      create table if not exists chat_bookmark_steps (
        id text primary key,
        chat_bookmark_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(chat_bookmark_id) references chat_bookmarks(id)
      );

      create table if not exists project_tasks (
        id text primary key,
        project_id text not null,
        title text not null,
        prompt text not null,
        attachments_json text not null default '[]',
        status text not null default 'open',
        run_id text,
        pull_request_url text,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id)
      );

      create table if not exists project_automations (
        id text primary key,
        project_id text not null,
        name text not null,
        prompt text not null,
        attachments_json text not null default '[]',
        cron_expression text not null,
        time_zone text not null,
        model_id text not null,
        effort text not null default 'auto',
        execution_options_json text not null default '{}',
        workspace_type text not null default 'worktree',
        base_branch text,
        only_if_previous_finished integer not null default 1,
        enabled integer not null default 1,
        last_scheduled_at text,
        next_run_at text not null,
        last_error text,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists project_insights (
        id text primary key,
        project_id text not null,
        kind text not null,
        title text not null,
        summary text not null,
        data_json text not null default '{}',
        model_id text,
        generated_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists project_lab_threads (
        id text primary key,
        project_id text not null,
        kind text not null,
        lab_mode text not null default 'new-feature',
        status text not null,
        origin text not null,
        title text not null,
        summary text not null,
        outcome text,
        seed_prompt text,
        implementation_prompt text,
        implementation_run_id text,
        implementation_model_id text,
        review_model_id text,
        base_branch text,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(implementation_run_id) references runs(id),
        foreign key(implementation_model_id) references models(id),
        foreign key(review_model_id) references models(id)
      );

      create table if not exists project_lab_events (
        id text primary key,
        thread_id text not null,
        role text not null,
        label text not null,
        content text not null,
        created_at text not null,
        foreign key(thread_id) references project_lab_threads(id)
      );

      create table if not exists project_loops (
        id text primary key,
        project_id text not null,
        name text not null,
        prompt text not null,
        runner_model_id text not null,
        review_model_id text,
        merge_policy text not null default 'wait-for-approval',
        ui_change_policy text not null default 'auto',
        pr_review_policy text not null default 'none',
        ui_review_instructions text,
        base_branch text not null,
        status text not null,
        plan_summary text,
        error_message text,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        foreign key(project_id) references projects(id)
      );

      create table if not exists project_loop_iterations (
        id text primary key,
        loop_id text not null,
        iteration_index integer not null,
        title text not null,
        objective text not null,
        status text not null default 'pending',
        run_id text,
        branch_name text,
        pr_url text,
        pr_number integer,
        target_branch text,
        error_message text,
        ai_review_posted integer not null default 0,
        processed_comment_ids_json text not null default '[]',
        created_at text not null,
        updated_at text not null,
        foreign key(loop_id) references project_loops(id)
      );

      create table if not exists project_loop_events (
        id text primary key,
        loop_id text not null,
        iteration_id text,
        role text not null,
        label text not null,
        content text not null,
        created_at text not null,
        foreign key(loop_id) references project_loops(id)
      );

      create table if not exists project_loop_ui_reviews (
        id text primary key,
        loop_id text not null,
        iteration_id text not null,
        round integer not null default 1,
        page_name text not null,
        description text,
        image_path text not null,
        status text not null default 'pending',
        feedback text,
        created_at text not null,
        updated_at text not null,
        foreign key(loop_id) references project_loops(id),
        foreign key(iteration_id) references project_loop_iterations(id)
      );

      create index if not exists idx_project_loops_project_id on project_loops(project_id);
      create index if not exists idx_project_loops_runner_model_id on project_loops(runner_model_id);
      create index if not exists idx_project_loops_review_model_id on project_loops(review_model_id);
      create index if not exists idx_project_loop_iterations_loop_id on project_loop_iterations(loop_id, iteration_index);
      create unique index if not exists idx_project_loop_iterations_loop_index_unique on project_loop_iterations(loop_id, iteration_index);
      create index if not exists idx_project_loop_events_loop_id on project_loop_events(loop_id, created_at);
      create index if not exists idx_project_loop_ui_reviews_loop_id on project_loop_ui_reviews(loop_id, created_at);

      create unique index if not exists idx_project_insights_project_kind on project_insights(project_id, kind);
      create index if not exists idx_project_lab_threads_project_id on project_lab_threads(project_id);
      create index if not exists idx_project_lab_threads_implementation_model_id on project_lab_threads(implementation_model_id);
      create index if not exists idx_project_lab_threads_review_model_id on project_lab_threads(review_model_id);
      create index if not exists idx_project_lab_events_thread_id on project_lab_events(thread_id);
      create index if not exists idx_runs_project_created_at on runs(project_id, created_at desc);
      create index if not exists idx_runs_model_id on runs(model_id);
      create index if not exists idx_runs_status on runs(status);
      create index if not exists idx_runs_parent_run_id on runs(parent_run_id);
      create index if not exists idx_runs_root_run_id on runs(root_run_id);
      create index if not exists idx_run_steps_run_created_at on run_steps(run_id, created_at);
      create index if not exists idx_run_notes_run_status_updated on run_notes(run_id, status, updated_at desc);
      create index if not exists idx_chat_steps_chat_created_at on chat_steps(chat_id, created_at);
      create index if not exists idx_chats_model_id on chats(model_id);
      create index if not exists idx_project_insights_model_id on project_insights(model_id);
      create index if not exists idx_project_automations_project on project_automations(project_id, name);
      create index if not exists idx_project_automations_due on project_automations(enabled, next_run_at);
      create index if not exists idx_project_automations_model on project_automations(model_id);
      create index if not exists idx_worktrees_run_id on worktrees(run_id);
      create index if not exists idx_bookmarks_original_run_id on bookmarks(original_run_id);
      create index if not exists idx_chat_bookmarks_original_chat_id on chat_bookmarks(original_chat_id);

`;
