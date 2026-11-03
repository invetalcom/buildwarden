export const SKILLS_SCHEMA_SQL = `
  create table if not exists skill_packages (
    id text primary key,
    record_json text not null
  );
  create table if not exists skill_session_state (
    owner_kind text not null check (owner_kind in ('run', 'chat')),
    owner_id text not null,
    snapshot_json text not null,
    primary key (owner_kind, owner_id)
  );
  create trigger if not exists delete_run_skills after delete on runs begin
    delete from skill_session_state where owner_kind = 'run' and owner_id = old.id;
  end;
  create trigger if not exists delete_chat_skills after delete on chats begin
    delete from skill_session_state where owner_kind = 'chat' and owner_id = old.id;
  end;
`;
