// Native read of a managed profile's public session binding
// (<store>/managed-profile-sessions/<profile_id>.json), mirroring the worker's
// ProfileBindings validation. Only the public owner id is read; no account data.
use std::{
    fs,
    io::{ErrorKind, Read},
    path::Path,
};

use serde_json::Value;

use crate::{
    launcher::uuid,
    launcher_process::{regular, safe_ancestors},
    profile_store::Provider,
};

const MAX_BYTES: u64 = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Binding {
    /// No binding file: the worker reports profile_unbound.
    Absent,
    /// A runtime was being prepared and never confirmed: needs review.
    Reserved,
    /// Ready binding with its runtime owner uuid.
    Ready(String),
    /// Present but not a valid binding for this profile/provider.
    Invalid,
}

fn provider_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
    }
}

/// Same-inode, single-link check on the opened handle and the path (the worker
/// compares lstat/fstat identity and rejects nlink != 1).
#[cfg(unix)]
fn same_file(path: &Path, file: &fs::File) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(before), Ok(opened)) = (fs::symlink_metadata(path), file.metadata()) else {
        return false;
    };
    before.nlink() == 1
        && opened.nlink() == 1
        && before.dev() == opened.dev()
        && before.ino() == opened.ino()
}
#[cfg(not(unix))]
fn same_file(path: &Path, file: &fs::File) -> bool {
    // std exposes no stable link count / file index on Windows; the lstat and
    // handle views are both required to be plain regular files.
    regular(path) && file.metadata().is_ok_and(|metadata| metadata.is_file())
}

pub(crate) fn read(store: &Path, profile_id: &str, provider: Provider) -> Binding {
    if !uuid(profile_id) {
        return Binding::Invalid;
    }
    // The worker requires every ancestor of the binding directory's parent to be
    // a real directory, then lstat-s the binding directory itself (ENOENT -> unbound).
    if !safe_ancestors(store) {
        return Binding::Invalid;
    }
    let root = store.join("managed-profile-sessions");
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Binding::Absent,
        Err(_) => return Binding::Invalid,
        Ok(_) => {}
    }
    if !safe_ancestors(&root) {
        return Binding::Invalid;
    }
    let path = root.join(format!("{profile_id}.json"));
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Binding::Absent,
        Err(_) => return Binding::Invalid,
        Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_BYTES => {
            return Binding::Invalid
        }
        Ok(_) => {}
    }
    if !regular(&path) {
        return Binding::Invalid;
    }
    let Ok(file) = fs::File::open(&path) else {
        return Binding::Invalid;
    };
    if !same_file(&path, &file) {
        return Binding::Invalid;
    }
    let mut bytes = Vec::new();
    if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_BYTES {
        return Binding::Invalid;
    }
    let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(&bytes) else {
        return Binding::Invalid;
    };
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    if keys != ["owner", "profile_id", "provider", "schema_version", "state"] {
        return Binding::Invalid;
    }
    let text = |key: &str| object.get(key).and_then(Value::as_str);
    let (Some("1.0"), Some(bound), Some(bound_provider), Some(owner), Some(state)) = (
        text("schema_version"),
        text("profile_id"),
        text("provider"),
        text("owner"),
        text("state"),
    ) else {
        return Binding::Invalid;
    };
    if bound != profile_id
        || bound_provider != provider_name(provider)
        || !uuid(owner)
        || owner == profile_id
    {
        return Binding::Invalid;
    }
    match state {
        "reserved" => Binding::Reserved,
        "ready" => Binding::Ready(owner.to_owned()),
        _ => Binding::Invalid,
    }
}

#[cfg(test)]
mod tests;
