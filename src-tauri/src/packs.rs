use crate::documents::write_document;
use crate::minecraft_languages::valid_locale;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

const MAX_ARCHIVE_BYTES: u64 = 384 * 1024 * 1024;
const MAX_FOLDER_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FOLDER_ENTRIES: usize = 150_000;
const FOLDER_VIEW_NAME: &str = "view-v3.zip";
const ORDER_FILE_NAME: &str = "order.json";

#[derive(Clone)]
pub struct PackStore {
    root: PathBuf,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct PackInfo {
    id: String,
    pub name: String,
    kind: PackKind,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PackKind {
    Zip,
    Jar,
    Folder,
}

impl PackStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn list(&self) -> Result<Vec<PackInfo>, String> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut packs: Vec<_> = fs::read_dir(&self.root)
            .map_err(message)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let id = entry.file_name();
                let id = id.to_str()?;
                if !valid_id(id) || !entry.file_type().ok()?.is_dir() || is_link(&path).ok()? {
                    return None;
                }
                let info = read_info(&path).ok()?;
                (info.id == id).then_some(info)
            })
            .collect();
        // Stored IDs run from lowest to highest priority. Unlisted packs go above them.
        let order: Vec<String> = File::open(self.root.join(ORDER_FILE_NAME))
            .ok()
            .and_then(|file| serde_json::from_reader(file).ok())
            .unwrap_or_default();
        let positions: HashMap<_, _> = order
            .iter()
            .enumerate()
            .map(|(index, id)| (id.as_str(), index))
            .collect();
        packs.sort_unstable_by(|a, b| {
            let rank = |pack: &PackInfo| {
                positions
                    .get(pack.id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX)
            };
            rank(a).cmp(&rank(b)).then_with(|| a.id.cmp(&b.id))
        });
        Ok(packs)
    }

    pub fn set_order(&self, ids: &[String]) -> Result<(), String> {
        let mut seen = HashSet::with_capacity(ids.len());
        for id in ids {
            if !valid_id(id) || !seen.insert(id) {
                return Err("资源包顺序包含无效或重复的 ID。".into());
            }
        }
        let bytes = serde_json::to_vec(ids).map_err(message)?;
        write_document(&self.root.join(ORDER_FILE_NAME), &bytes, true)
    }

    pub fn import(&self, source: &Path) -> Result<PackInfo, String> {
        fs::create_dir_all(&self.root).map_err(message)?;
        let name = source
            .file_name()
            .ok_or("请选择资源包 ZIP、JAR 或文件夹。")?
            .to_string_lossy()
            .into_owned();
        let source = source.canonicalize().map_err(message)?;
        let root = self.root.canonicalize().map_err(message)?;
        if root.starts_with(&source) || source.starts_with(&root) {
            return Err("请选择资源包存储目录以外的文件或文件夹。".into());
        }
        let kind = if source.is_dir() {
            if !source.join("assets").is_dir()
                || is_link(&source.join("assets")).map_err(message)?
            {
                return Err("请选择包含 assets 目录的资源包根文件夹。".into());
            }
            PackKind::Folder
        } else {
            match source
                .extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("zip") => PackKind::Zip,
                Some("jar") => PackKind::Jar,
                _ => return Err("请选择 ZIP、JAR 或资源包文件夹。".into()),
            }
        };

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(message)?
            .as_millis();
        let id = format!("{timestamp:013}-{}", Uuid::new_v4());
        let staging = root.join(format!(".import-{id}"));
        fs::create_dir(&staging).map_err(message)?;
        let info = PackInfo { id, name, kind };
        let result = (|| {
            if matches!(kind, PackKind::Folder) {
                let target = staging.join("folder");
                copy_folder(&source, &target, &mut 0, &mut 0, 0)?;
                let zip = folder_archive(
                    &target,
                    File::create(staging.join(FOLDER_VIEW_NAME)).map_err(message)?,
                )?;
                zip.sync_all().map_err(message)?;
            } else {
                let target = staging.join(if matches!(kind, PackKind::Jar) {
                    "pack.jar"
                } else {
                    "pack.zip"
                });
                if fs::metadata(&source).map_err(message)?.len() > MAX_ARCHIVE_BYTES {
                    return Err("资源包文件超过 384 MiB。".into());
                }
                fs::copy(&source, &target).map_err(message)?;
                validate_archive(&target)?;
            }
            let metadata = serde_json::to_vec(&info).map_err(message)?;
            fs::write(staging.join("pack.json"), metadata).map_err(message)?;
            fs::rename(&staging, root.join(&info.id)).map_err(message)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result.map(|()| info)
    }

    pub fn bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let path = self.entry(id)?;
        let file = match read_info(&path)?.kind {
            PackKind::Zip => path.join("pack.zip"),
            PackKind::Jar => path.join("pack.jar"),
            PackKind::Folder => folder_view(&path)?,
        };
        if fs::metadata(&file).map_err(message)?.len() > MAX_ARCHIVE_BYTES {
            return Err("资源包文件超过 384 MiB。".into());
        }
        fs::read(file).map_err(message)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.entry(id)?;
        let staging = self.root.join(format!(".removed-{}", Uuid::new_v4()));
        fs::rename(&path, &staging).map_err(message)?;
        if let Err(err) = fs::remove_dir_all(&staging) {
            if staging.join("pack.json").exists() {
                let _ = fs::rename(&staging, &path);
            }
            return Err(message(err));
        }
        Ok(())
    }

    fn entry(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("资源包 ID 无效。".into());
        }
        let path = self.root.join(id);
        if is_link(&path).map_err(message)? || !path.is_dir() || read_info(&path)?.id != id {
            return Err("资源包不存在。".into());
        }
        Ok(path)
    }
}

fn valid_id(id: &str) -> bool {
    let Some((timestamp, uuid)) = id.split_once('-') else {
        return false;
    };
    timestamp.len() == 13
        && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        && Uuid::parse_str(uuid).is_ok_and(|value| value.to_string() == uuid)
}

fn read_info(path: &Path) -> Result<PackInfo, String> {
    serde_json::from_reader(File::open(path.join("pack.json")).map_err(message)?).map_err(message)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn is_link(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(metadata.file_attributes() & 0x400 != 0) // Reparse point, including directory junctions.
    }
    #[cfg(not(windows))]
    Ok(metadata.file_type().is_symlink())
}

fn copy_folder(
    source: &Path,
    target: &Path,
    bytes: &mut u64,
    entries: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 64 {
        return Err("资源包目录层级过深。".into());
    }
    fs::create_dir(target).map_err(message)?;
    for entry in fs::read_dir(source).map_err(message)? {
        let entry = entry.map_err(message)?;
        let path = entry.path();
        if is_link(&path).map_err(message)? {
            continue;
        }
        *entries += 1;
        if *entries > MAX_FOLDER_ENTRIES {
            return Err("资源包中的文件数量超过上限。".into());
        }
        let target = target.join(entry.file_name());
        let metadata = entry.metadata().map_err(message)?;
        if metadata.is_dir() {
            copy_folder(&path, &target, bytes, entries, depth + 1)?;
        } else if metadata.is_file() {
            *bytes = bytes.saturating_add(metadata.len());
            if *bytes > MAX_FOLDER_BYTES {
                return Err("资源包文件夹超过 1 GiB。".into());
            }
            fs::copy(&path, target).map_err(message)?;
        }
    }
    Ok(())
}

fn supported(path: &str) -> bool {
    let Some((_, asset)) = path
        .split_once("/assets/")
        .or_else(|| path.strip_prefix("assets/").map(|asset| ("", asset)))
    else {
        return false;
    };
    let Some((namespace, relative)) = asset.split_once('/') else {
        return false;
    };
    if namespace.is_empty()
        || !namespace
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || b"_.-".contains(&ch))
    {
        return false;
    }
    let Some((kind, name)) = relative.split_once('/') else {
        return false;
    };
    match kind {
        "blockstates" | "models" | "items" => name.ends_with(".json"),
        "textures" => name.ends_with(".png") || name.ends_with(".png.mcmeta"),
        "lang" => name.rsplit_once('.').is_some_and(|(code, extension)| {
            (extension.eq_ignore_ascii_case("json") || extension.eq_ignore_ascii_case("lang"))
                && valid_locale(&code.to_ascii_lowercase().replace('-', "_"))
        }),
        _ => false,
    }
}

fn validate_archive(path: &Path) -> Result<(), String> {
    let file = File::open(path).map_err(message)?;
    if file.metadata().map_err(message)?.len() > MAX_ARCHIVE_BYTES {
        return Err("资源包文件超过 384 MiB。".into());
    }
    let mut archive = ZipArchive::new(file).map_err(message)?;
    let mut bytes = 0_u64;
    let mut found = false;
    for index in 0..archive.len() {
        let file = archive.by_index_raw(index).map_err(message)?;
        if !file.is_file() || !supported(file.name()) {
            continue;
        }
        found = true;
        bytes = bytes.saturating_add(file.size());
        if bytes > MAX_ARCHIVE_BYTES {
            return Err("资源包的可加载内容超过 384 MiB。".into());
        }
    }
    if !found {
        return Err("资源包中没有找到 assets 下的方块资源。".into());
    }
    Ok(())
}

fn folder_view(path: &Path) -> Result<PathBuf, String> {
    let view = path.join(FOLDER_VIEW_NAME);
    if !view.is_file() {
        let mut staging = tempfile::NamedTempFile::new_in(path).map_err(message)?;
        folder_archive(&path.join("folder"), staging.as_file_mut())?
            .sync_all()
            .map_err(message)?;
        staging.persist(&view).map_err(message)?;
        let _ = fs::remove_file(path.join("view.zip"));
        let _ = fs::remove_file(path.join("view-v2.zip"));
    }
    Ok(view)
}

fn folder_archive<W: io::Write + io::Seek>(folder: &Path, output: W) -> Result<W, String> {
    let mut zip = ZipWriter::new(output);
    let mut pending = vec![folder.join("assets")];
    let mut size = 0_u64;
    let mut found = false;
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(message)? {
            let entry = entry.map_err(message)?;
            let path = entry.path();
            let kind = entry.file_type().map_err(message)?;
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                let name = path
                    .strip_prefix(folder)
                    .map_err(message)?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !supported(&name) {
                    continue;
                }
                let mut input = File::open(path).map_err(message)?;
                size = size.saturating_add(
                    input.metadata().map_err(message)?.len() + 2 * name.len() as u64 + 80,
                );
                if size >= MAX_ARCHIVE_BYTES {
                    return Err("资源包的可加载内容超过 384 MiB。".into());
                }
                found = true;
                zip.start_file(name, options).map_err(message)?;
                io::copy(&mut input, &mut zip).map_err(message)?;
            }
        }
    }
    if !found {
        return Err("资源包中没有找到 assets 下的方块资源。".into());
    }
    zip.finish().map_err(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    const BLOCKSTATE: &str = "assets/fixture/blockstates/test_block.json";
    const JSON: &str = r#"{"variants":{"":{"model":"fixture:block/test_block"}}}"#;

    #[test]
    fn archive_copies_survive_source_removal_and_store_reopen() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("resource-packs");
        let mut expected = Vec::new();
        for extension in ["zip", "jar"] {
            let path = temporary.path().join(format!("fixture.{extension}"));
            let mut archive = ZipWriter::new(File::create(&path).unwrap());
            archive
                .start_file(BLOCKSTATE, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(JSON.as_bytes()).unwrap();
            drop(archive.finish().unwrap());

            let bytes = fs::read(&path).unwrap();
            let info = PackStore::new(root.clone()).import(&path).unwrap();
            fs::remove_file(path).unwrap();
            expected.push((info.id, info.name, bytes));
        }

        let reopened = PackStore::new(root);
        let packs = reopened.list().unwrap();
        assert_eq!(packs.len(), 2);
        for (id, name, bytes) in expected {
            assert!(packs.iter().any(|pack| pack.id == id && pack.name == name));
            assert_eq!(reopened.bytes(&id).unwrap(), bytes);
        }
    }

    #[test]
    fn resource_pack_order_survives_restart_and_applies_to_current_packs() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("resource-packs");
        let folder = temporary.path().join("fixture-folder");
        let source = folder.join(BLOCKSTATE);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(source, JSON).unwrap();
        let store = PackStore::new(root.clone());
        let first = store.import(&folder).unwrap();
        let second = store.import(&folder).unwrap();
        let ids = |store: &PackStore| {
            store
                .list()
                .unwrap()
                .into_iter()
                .map(|pack| pack.id)
                .collect::<Vec<_>>()
        };

        let mut expected = vec![first.id, second.id];
        expected.sort();
        assert_eq!(ids(&store), expected);
        expected.reverse();
        store.set_order(&expected).unwrap();
        let reopened = PackStore::new(root);
        assert_eq!(ids(&reopened), expected);

        assert!(
            reopened
                .set_order(&[expected[0].clone(), expected[0].clone()])
                .is_err()
        );
        assert_eq!(ids(&reopened), expected);
        expected.push(reopened.import(&folder).unwrap().id);
        assert_eq!(ids(&reopened), expected);
        reopened.remove(&expected.remove(0)).unwrap();
        assert_eq!(ids(&reopened), expected);
    }

    #[test]
    fn folder_copies_are_read_from_the_global_store() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("resource-packs");
        let folder = temporary.path().join("fixture-folder");
        let source = folder.join(BLOCKSTATE);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, JSON).unwrap();
        let item = "assets/fixture/items/test_block.json";
        let item_json =
            r#"{"model":{"type":"minecraft:model","model":"fixture:block/test_block"}}"#;
        fs::create_dir(folder.join("assets/fixture/items")).unwrap();
        fs::write(folder.join(item), item_json).unwrap();
        let language = "assets/fixture/lang/ja_jp.json";
        fs::create_dir(folder.join("assets/fixture/lang")).unwrap();
        fs::write(
            folder.join(language),
            r#"{"block.fixture.test_block":"テスト"}"#,
        )
        .unwrap();
        fs::write(folder.join("README.txt"), "full folder copy").unwrap();

        let info = PackStore::new(root.clone()).import(&folder).unwrap();
        fs::write(source, "changed source").unwrap();
        let stored = root.join(&info.id);
        fs::remove_file(stored.join(FOLDER_VIEW_NAME)).unwrap();
        let mut old_view = ZipWriter::new(File::create(stored.join("view-v2.zip")).unwrap());
        old_view
            .start_file(BLOCKSTATE, SimpleFileOptions::default())
            .unwrap();
        old_view.write_all(JSON.as_bytes()).unwrap();
        drop(old_view.finish().unwrap());
        let reopened = PackStore::new(root.clone());
        assert_eq!(reopened.list().unwrap()[0].id, info.id);
        assert_eq!(
            fs::read_to_string(root.join(&info.id).join("folder/README.txt")).unwrap(),
            "full folder copy"
        );
        let bytes = reopened.bytes(&info.id).unwrap();
        let mut archive = ZipArchive::new(io::Cursor::new(bytes)).unwrap();
        let mut json = String::new();
        archive
            .by_name(BLOCKSTATE)
            .unwrap()
            .read_to_string(&mut json)
            .unwrap();
        assert_eq!(json, JSON);
        json.clear();
        archive
            .by_name(item)
            .unwrap()
            .read_to_string(&mut json)
            .unwrap();
        assert_eq!(json, item_json);
        assert!(archive.by_name(language).is_ok());
        reopened.remove(&info.id).unwrap();
        assert!(reopened.list().unwrap().is_empty());
    }
}
