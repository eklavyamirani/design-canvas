-- Shared drawings (src/store.ts). A room is open to anyone signed in to the
-- platform who has its link; created_by is for the record only.
create table rooms (
  id text primary key,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Excalidraw elements, deleted ones included: a deletion is an edit that
-- has to win over older versions like any other.
create table room_elements (
  room_id text not null references rooms (id) on delete cascade,
  id text not null,
  version bigint not null,
  version_nonce bigint not null,
  data jsonb not null,
  primary key (room_id, id)
);

-- Pasted images, as data URLs. The id is a hash of the content.
create table room_files (
  room_id text not null references rooms (id) on delete cascade,
  id text not null,
  mime_type text not null,
  data_url text not null,
  created bigint not null,
  primary key (room_id, id)
);
