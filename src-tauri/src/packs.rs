use crate::documents::write_document;
use crate::minecraft_languages::valid_locale;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const MAX_ARCHIVE_BYTES: u64 = 384 * 1024 * 1024;
const MAX_FOLDER_ENTRIES: usize = 150_000;
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
    #[serde(default)]
    path: PathBuf,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PackKind {
    Zip,
    Jar,
    Folder,
}

impl PackKind {
    fn archive(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "zip" => Some(Self::Zip),
            "jar" => Some(Self::Jar),
            _ => None,
        }
    }
}

pub fn list_archives(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut archives = Vec::new();
    for entry in fs::read_dir(directory).map_err(message)? {
        let entry = entry.map_err(message)?;
        let path = entry.path();
        if PackKind::archive(&path).is_some() && entry.file_type().map_err(message)?.is_file() {
            archives.push(path);
        }
    }
    archives.sort_unstable();
    Ok(archives)
}

impl PackStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn list(&self) -> Result<Vec<PackInfo>, String> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(message(error)),
        };
        let mut packs: Vec<_> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let id = entry.file_name();
                let id = id.to_str()?;
                let metadata = entry.metadata().ok()?;
                if !valid_id(id) || !metadata.is_dir() || is_link(&metadata) {
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
        if !source.is_absolute() {
            return Err("请提供资源包 ZIP、JAR 或文件夹的绝对路径。".into());
        }
        let name = source
            .file_name()
            .ok_or("请选择资源包 ZIP、JAR 或文件夹。")?
            .to_string_lossy()
            .into_owned();
        let metadata = fs::metadata(source).map_err(resource_error)?;
        let kind = if metadata.is_dir() {
            PackKind::Folder
        } else if metadata.is_file() {
            PackKind::archive(source).ok_or("请选择 ZIP、JAR 或资源包文件夹。")?
        } else {
            return Err("请选择 ZIP、JAR 或资源包文件夹。".into());
        };

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(message)?
            .as_millis();
        let info = PackInfo {
            id: format!("{timestamp:013}-{}", Uuid::new_v4()),
            name,
            kind,
            path: source.to_owned(),
        };
        let bytes = serde_json::to_vec(&info).map_err(message)?;
        let entry = self.root.join(&info.id);
        fs::create_dir_all(&entry).map_err(message)?;
        if let Err(error) = write_document(&entry.join("pack.json"), &bytes, false) {
            let _ = fs::remove_dir(&entry);
            return Err(error);
        }
        Ok(info)
    }

    pub fn bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let (_, info) = self.entry(id)?;
        let metadata = fs::metadata(&info.path).map_err(resource_error)?;
        if matches!(info.kind, PackKind::Folder) {
            if !metadata.is_dir() {
                return Err("资源包路径不再指向文件夹。".into());
            }
            return folder_archive(&info.path);
        }
        if !metadata.is_file() {
            return Err("资源包路径不再指向文件。".into());
        }
        if metadata.len() > MAX_ARCHIVE_BYTES {
            return Err("资源包文件超过 384 MiB。".into());
        }
        let mut bytes = Vec::new();
        File::open(&info.path)
            .map_err(resource_error)?
            .take(MAX_ARCHIVE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(resource_error)?;
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err("资源包文件超过 384 MiB。".into());
        }
        Ok(bytes)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let (entry, _) = self.entry(id)?;
        fs::remove_file(entry.join("pack.json")).map_err(message)?;
        let _ = fs::remove_dir(&entry);
        Ok(())
    }

    fn entry(&self, id: &str) -> Result<(PathBuf, PackInfo), String> {
        if !valid_id(id) {
            return Err("资源包 ID 无效。".into());
        }
        let path = self.root.join(id);
        let metadata = fs::symlink_metadata(&path).map_err(message)?;
        if !metadata.is_dir() || is_link(&metadata) {
            return Err("资源包不存在。".into());
        }
        let info = read_info(&path)?;
        if info.id != id {
            return Err("资源包不存在。".into());
        }
        Ok((path, info))
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
    let file = File::open(path.join("pack.json")).map_err(message)?;
    let mut info: PackInfo = serde_json::from_reader(file).map_err(message)?;
    if info.path.as_os_str().is_empty() {
        // Older entries only recorded the name and kind of the stored copy.
        info.path = path.join(match info.kind {
            PackKind::Zip => "pack.zip",
            PackKind::Jar => "pack.jar",
            PackKind::Folder => "folder",
        });
    }
    Ok(info)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn resource_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => format!("找不到资源包或其中的文件。{error}"),
        io::ErrorKind::PermissionDenied => format!("没有读取资源包的权限。{error}"),
        _ => error.to_string(),
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // Reparse point, including directory junctions.
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn supported(path: &str) -> bool {
    let section = |name: &str| {
        path.strip_prefix(name.trim_start_matches('/'))
            .or_else(|| path.split_once(name).map(|(_, rest)| rest))
    };
    if let Some(data) = section("/data/")
        && let Some((namespace, pattern)) = data.split_once("/banner_pattern/")
        && valid_namespace(namespace)
        && pattern.ends_with(".json")
    {
        return true;
    }
    let Some(asset) = section("/assets/") else {
        return false;
    };
    let Some((namespace, relative)) = asset.split_once('/') else {
        return false;
    };
    if !valid_namespace(namespace) {
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

fn valid_namespace(namespace: &str) -> bool {
    !namespace.is_empty()
        && namespace
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || b"_.-".contains(&ch))
}

fn folder_archive(folder: &Path) -> Result<Vec<u8>, String> {
    let assets = folder.join("assets");
    match fs::metadata(&assets) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err("资源包中的 assets 路径不是文件夹。".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err("资源包目录缺少 assets 文件夹。".into());
        }
        Err(error) => return Err(resource_error(error)),
    }

    // Use the same resource parser as ZIP and JAR packs. The archive is in memory only.
    let mut zip = ZipWriter::new(io::Cursor::new(Vec::new()));
    let mut pending = vec![assets];
    let data = folder.join("data");
    match fs::metadata(&data) {
        Ok(metadata) if metadata.is_dir() => pending.push(data),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(resource_error(error)),
    }
    let mut remaining = MAX_ARCHIVE_BYTES;
    let mut entries = 0;
    let mut found = false;
    let too_large = "资源包的可加载内容超过 384 MiB。";
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(resource_error)? {
            let entry = entry.map_err(resource_error)?;
            entries += 1;
            if entries > MAX_FOLDER_ENTRIES {
                return Err("资源包中的文件数量超过上限。".into());
            }
            let path = entry.path();
            let metadata = entry.metadata().map_err(resource_error)?;
            if is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let name = path
                    .strip_prefix(folder)
                    .map_err(message)?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !supported(&name) {
                    continue;
                }
                remaining = remaining
                    .checked_sub(2 * name.len() as u64 + 80)
                    .ok_or(too_large)?;
                if metadata.len() > remaining {
                    return Err(too_large.into());
                }
                let input = File::open(path).map_err(resource_error)?;
                found = true;
                zip.start_file(name, options).map_err(message)?;
                let copied =
                    io::copy(&mut input.take(remaining + 1), &mut zip).map_err(resource_error)?;
                remaining = remaining.checked_sub(copied).ok_or(too_large)?;
            }
        }
    }
    if !found {
        return Err("资源包中没有找到 assets 下的方块资源。".into());
    }
    let bytes = zip.finish().map_err(message)?.into_inner();
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(too_large.into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::ZipArchive;

    const BLOCKSTATE: &str = "assets/fixture/blockstates/test_block.json";
    const JSON: &str = r#"{"variants":{"":{"model":"fixture:block/test_block"}}}"#;

    fn archive_bytes(contents: &str) -> Vec<u8> {
        let mut archive = ZipWriter::new(io::Cursor::new(Vec::new()));
        archive
            .start_file(BLOCKSTATE, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(contents.as_bytes()).unwrap();
        archive.finish().unwrap().into_inner()
    }

    #[test]
    fn lists_zip_and_jar_files_in_the_selected_directory_in_filename_order() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["20-patch.JAR", "10-base.zip", "notes.txt"] {
            fs::write(directory.path().join(name), []).unwrap();
        }
        let nested = directory.path().join("nested.zip");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("other.jar"), []).unwrap();
        assert_eq!(
            list_archives(directory.path()).unwrap(),
            ["10-base.zip", "20-patch.JAR"].map(|name| directory.path().join(name))
        );
    }

    #[test]
    fn archive_links_keep_the_original_path_and_survive_missing_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("resource-packs");
        let initial = archive_bytes(JSON);
        let updated = archive_bytes("{}");
        for extension in ["zip", "JAR"] {
            let path = temporary.path().join(format!("fixture.{extension}"));
            fs::write(&path, &initial).unwrap();
            let info = PackStore::new(root.clone()).import(&path).unwrap();
            assert_eq!(info.path, path);
            let entry = root.join(&info.id);
            assert_eq!(fs::read_dir(&entry).unwrap().count(), 1);
            assert!(entry.join("pack.json").is_file());

            fs::remove_file(&path).unwrap();
            let reopened = PackStore::new(root.clone());
            let listed = reopened.list().unwrap().pop().unwrap();
            assert_eq!(listed.id, info.id);
            assert_eq!(listed.path, path);
            assert!(
                reopened
                    .bytes(&info.id)
                    .unwrap_err()
                    .contains("找不到资源包")
            );

            fs::write(&path, &updated).unwrap();
            assert_eq!(reopened.bytes(&info.id).unwrap(), updated);
            reopened.remove(&info.id).unwrap();
            assert_eq!(fs::read(&path).unwrap(), updated);
            assert!(reopened.list().unwrap().is_empty());
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
    fn folder_links_read_live_project_resources_without_a_disk_archive() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("resource-packs");
        let folder = temporary.path().join("workspace/src/main/resources");
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
        let banner = "data/fixture/banner_pattern/test.json";
        fs::create_dir_all(folder.join(banner).parent().unwrap()).unwrap();
        fs::write(folder.join(banner), r#"{"asset_id":"fixture:test"}"#).unwrap();
        fs::write(folder.join("README.txt"), "ignored").unwrap();

        let info = PackStore::new(root.clone()).import(&folder).unwrap();
        let updated = r#"{"variants":{"":{"model":"fixture:block/updated"}}}"#;
        fs::write(&source, updated).unwrap();
        let reopened = PackStore::new(root.clone());
        assert_eq!(reopened.list().unwrap()[0].path, folder);
        let bytes = reopened.bytes(&info.id).unwrap();
        let mut archive = ZipArchive::new(io::Cursor::new(bytes)).unwrap();
        let mut json = String::new();
        archive
            .by_name(BLOCKSTATE)
            .unwrap()
            .read_to_string(&mut json)
            .unwrap();
        assert_eq!(json, updated);
        json.clear();
        archive
            .by_name(item)
            .unwrap()
            .read_to_string(&mut json)
            .unwrap();
        assert_eq!(json, item_json);
        assert!(archive.by_name(language).is_ok());
        assert!(archive.by_name(banner).is_ok());
        assert!(archive.by_name("README.txt").is_err());
        assert_eq!(fs::read_dir(root.join(&info.id)).unwrap().count(), 1);
        fs::rename(folder.join("assets"), folder.join("assets-offline")).unwrap();
        assert!(
            reopened
                .bytes(&info.id)
                .unwrap_err()
                .contains("缺少 assets")
        );
        assert_eq!(reopened.list().unwrap()[0].id, info.id);
        reopened.remove(&info.id).unwrap();
        assert!(reopened.list().unwrap().is_empty());
        assert!(folder.join("assets-offline").is_dir());
    }

    #[test]
    fn old_entries_read_the_existing_local_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let mut ids = Vec::new();
        for (kind, name) in [
            ("zip", "pack.zip"),
            ("jar", "pack.jar"),
            ("folder", "folder"),
        ] {
            let id = format!("0000000000000-{}", Uuid::new_v4());
            let entry = temporary.path().join(&id);
            fs::create_dir(&entry).unwrap();
            let metadata = serde_json::json!({ "id": id, "name": name, "kind": kind });
            fs::write(entry.join("pack.json"), metadata.to_string()).unwrap();
            let path = entry.join(name);
            if kind == "folder" {
                let file = path.join(BLOCKSTATE);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, JSON).unwrap();
                fs::write(entry.join("view-v4.zip"), "stale cache").unwrap();
            } else {
                fs::write(&path, archive_bytes(JSON)).unwrap();
            }
            ids.push((id, path));
        }
        let store = PackStore::new(temporary.path().to_owned());
        let packs = store.list().unwrap();
        for (id, path) in ids {
            assert!(packs.iter().any(|pack| pack.id == id && pack.path == path));
            let bytes = store.bytes(&id).unwrap();
            let mut archive = ZipArchive::new(io::Cursor::new(bytes)).unwrap();
            assert!(archive.by_name(BLOCKSTATE).is_ok());
            store.remove(&id).unwrap();
            assert!(path.exists());
        }
        assert!(store.list().unwrap().is_empty());
    }
}
