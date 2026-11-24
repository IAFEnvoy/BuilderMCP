use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::State;
use tokio::fs;

const VERSION_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MAX_INDEX_BYTES: usize = 12 * 1024 * 1024;
const MAX_LANGUAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct MinecraftLanguages {
    cache: PathBuf,
    game_roots: Vec<PathBuf>,
    neoform: Option<PathBuf>,
}

#[derive(Deserialize)]
struct VersionManifest {
    versions: Vec<VersionEntry>,
}

#[derive(Deserialize)]
struct VersionEntry {
    id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionMetadata {
    asset_index: AssetIndexLocation,
}

#[derive(Deserialize)]
struct AssetIndexLocation {
    id: String,
    url: String,
    sha1: String,
    size: usize,
}

#[derive(Deserialize)]
struct AssetIndex {
    objects: BTreeMap<String, AssetObject>,
}

#[derive(Deserialize, Serialize)]
struct AssetObject {
    hash: String,
    size: usize,
}

#[derive(Deserialize, Serialize)]
struct LanguageAsset {
    object: AssetObject,
    legacy: bool,
}

type Languages = BTreeMap<String, LanguageAsset>;

#[derive(Default, Serialize)]
pub struct Translations {
    locales: Vec<String>,
    labels: BTreeMap<String, String>,
    unavailable: bool,
}

impl MinecraftLanguages {
    pub fn new(cache: PathBuf, home: Option<PathBuf>, data: Option<PathBuf>) -> Self {
        let mut game_roots = Vec::new();
        for root in data.iter().chain(home.iter()) {
            let path = root.join(".minecraft");
            if !game_roots.contains(&path) {
                game_roots.push(path);
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(data) = data {
            game_roots.push(data.join("minecraft"));
        }
        let gradle = std::env::var_os("GRADLE_USER_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| home.map(|path| path.join(".gradle")));
        Self {
            cache,
            game_roots,
            neoform: gradle.map(|path| path.join("caches/neoformruntime")),
        }
    }

    async fn load(&self, version: &str, locale: &str) -> Result<Translations, String> {
        if !valid_version(version) || !valid_locale(locale) {
            return Err("Invalid Minecraft version or locale.".into());
        }

        let index_path = self.cache.join("indexes").join(format!("{version}.json"));
        let index = match read_json(&index_path).await {
            Some(index) => index,
            None => {
                let index = match self.local_index(version).await {
                    Some(index) => index,
                    None => match download_index(version).await {
                        Ok(index) => index,
                        Err(_) => {
                            return Ok(Translations {
                                unavailable: true,
                                ..Default::default()
                            });
                        }
                    },
                };
                if let Ok(bytes) = serde_json::to_vec(&index) {
                    cache_file(index_path, bytes).await;
                }
                index
            }
        };
        let mut result = Translations {
            locales: index.keys().cloned().collect(),
            ..Default::default()
        };
        if let Some(asset) = index.get(locale) {
            match self.labels(asset).await {
                Some(labels) => result.labels = labels,
                None => result.unavailable = true,
            }
        }
        Ok(result)
    }

    async fn local_index(&self, version: &str) -> Option<Languages> {
        for root in &self.game_roots {
            let metadata = root
                .join("versions")
                .join(version)
                .join(format!("{version}.json"));
            if let Some(index) = local_index(root.join("assets"), metadata).await {
                return Some(index);
            }
        }
        if let Some(root) = &self.neoform {
            let metadata = root
                .join("artifacts")
                .join(format!("minecraft_{version}_version_manifest.json"));
            return local_index(root.join("assets"), metadata).await;
        }
        None
    }

    async fn labels(&self, asset: &LanguageAsset) -> Option<BTreeMap<String, String>> {
        let object = &asset.object;
        if !valid_hash(&object.hash) || object.size > MAX_LANGUAGE_BYTES {
            return None;
        }
        let key = Path::new(&object.hash[..2]).join(&object.hash);
        let cache = self.cache.join("objects").join(&key);
        if let Some(bytes) = read_asset(&cache, object).await {
            return parse_labels(&bytes, asset.legacy);
        }

        let launcher_assets = self.game_roots.iter().map(|root| root.join("assets"));
        let gradle_assets = self.neoform.iter().map(|root| root.join("assets"));
        for root in launcher_assets.chain(gradle_assets) {
            if let Some(bytes) = read_asset(&root.join("objects").join(&key), object).await {
                let labels = parse_labels(&bytes, asset.legacy)?;
                cache_file(cache, bytes).await;
                return Some(labels);
            }
        }

        let http = client().ok()?;
        let url = format!(
            "https://resources.download.minecraft.net/{}/{}",
            &object.hash[..2],
            object.hash
        );
        let bytes = download(&http, &url, MAX_LANGUAGE_BYTES).await.ok()?;
        if !matches_asset(&bytes, object) {
            return None;
        }
        let labels = parse_labels(&bytes, asset.legacy)?;
        cache_file(cache, bytes).await;
        Some(labels)
    }
}

#[tauri::command]
pub async fn minecraft_translations(
    store: State<'_, MinecraftLanguages>,
    version: String,
    locale: String,
) -> Result<Translations, String> {
    store.load(&version, &locale).await
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 80
        && version.as_bytes()[0].is_ascii_alphanumeric()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-+".contains(&byte))
}

pub(crate) fn valid_locale(locale: &str) -> bool {
    let mut pieces = locale.split('_');
    pieces.next().is_some_and(|first| {
        (2..=8).contains(&first.len()) && first.bytes().all(|ch| ch.is_ascii_lowercase())
    }) && pieces.clone().count() <= 2
        && pieces.all(|part| {
            (2..=8).contains(&part.len())
                && part
                    .bytes()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 40
        && hash
            .bytes()
            .all(|digit| digit.is_ascii_digit() || (b'a'..=b'f').contains(&digit))
}

fn matches_asset(bytes: &[u8], asset: &AssetObject) -> bool {
    bytes.len() == asset.size && format!("{:x}", Sha1::digest(bytes)) == asset.hash
}

async fn read_asset(path: &Path, asset: &AssetObject) -> Option<Vec<u8>> {
    if fs::metadata(path).await.ok()?.len() != asset.size as u64 {
        return None;
    }
    let bytes = fs::read(path).await.ok()?;
    matches_asset(&bytes, asset).then_some(bytes)
}

async fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    if fs::metadata(path).await.ok()?.len() > MAX_INDEX_BYTES as u64 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).await.ok()?).ok()
}

async fn local_index(assets: PathBuf, metadata: PathBuf) -> Option<Languages> {
    let version: VersionMetadata = read_json(&metadata).await?;
    let index = version.asset_index;
    if !valid_version(&index.id) || index.size > MAX_INDEX_BYTES {
        return None;
    }
    let path = assets.join("indexes").join(format!("{}.json", index.id));
    let bytes = read_asset(
        &path,
        &AssetObject {
            hash: index.sha1,
            size: index.size,
        },
    )
    .await?;
    parse_index(&bytes).ok()
}

fn parse_index(bytes: &[u8]) -> Result<Languages, String> {
    let index: AssetIndex = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let mut languages = Languages::new();
    for (key, object) in index.objects {
        let Some(file) = key.strip_prefix("minecraft/lang/") else {
            continue;
        };
        let Some((locale, extension)) = file.rsplit_once('.') else {
            continue;
        };
        let locale = locale.to_ascii_lowercase().replace('-', "_");
        if !valid_locale(&locale) || !valid_hash(&object.hash) || object.size > MAX_LANGUAGE_BYTES {
            continue;
        }
        let legacy = extension == "lang";
        if extension == "json" || (legacy && !languages.contains_key(&locale)) {
            languages.insert(locale, LanguageAsset { object, legacy });
        }
    }
    Ok(languages)
}

fn parse_labels(bytes: &[u8], legacy: bool) -> Option<BTreeMap<String, String>> {
    let text = std::str::from_utf8(bytes)
        .ok()?
        .trim_start_matches('\u{feff}');
    if legacy {
        return Some(
            text.lines()
                .filter(|line| !line.starts_with('#'))
                .filter_map(|line| line.split_once('='))
                .filter(|(key, value)| translation_key(key) && !value.trim().is_empty())
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .collect(),
        );
    }
    let entries: BTreeMap<String, serde_json::Value> = serde_json::from_str(text).ok()?;
    Some(
        entries
            .into_iter()
            .filter_map(|(key, value)| {
                let label = value.as_str()?;
                (translation_key(&key) && !label.trim().is_empty()).then(|| (key, label.to_owned()))
            })
            .collect(),
    )
}

fn translation_key(key: &str) -> bool {
    key.starts_with("block.") || key.starts_with("item.")
}

async fn cache_file(path: PathBuf, bytes: Vec<u8>) {
    let _ = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        std::fs::create_dir_all(parent)?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)?;
        staged.write_all(&bytes)?;
        staged.persist(path)?;
        Ok(())
    })
    .await;
}

fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
}

async fn download(http: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let url = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(
            url.host_str(),
            Some(
                "piston-meta.mojang.com"
                    | "launchermeta.mojang.com"
                    | "resources.download.minecraft.net"
            )
        )
    {
        return Err("Invalid Minecraft asset URL.".into());
    }
    let mut response = http
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("Minecraft asset exceeded the expected size.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn download_index(version: &str) -> Result<Languages, String> {
    let http = client().map_err(|error| error.to_string())?;
    let manifest = download(&http, VERSION_MANIFEST, MAX_INDEX_BYTES).await?;
    let manifest: VersionManifest =
        serde_json::from_slice(&manifest).map_err(|error| error.to_string())?;
    let entry = manifest
        .versions
        .into_iter()
        .find(|entry| entry.id == version)
        .ok_or("Minecraft version was not found.")?;
    let metadata = download(&http, &entry.url, MAX_INDEX_BYTES).await?;
    let metadata: VersionMetadata =
        serde_json::from_slice(&metadata).map_err(|error| error.to_string())?;
    let index = metadata.asset_index;
    let bytes = download(&http, &index.url, index.size.min(MAX_INDEX_BYTES)).await?;
    if !matches_asset(
        &bytes,
        &AssetObject {
            hash: index.sha1,
            size: index.size,
        },
    ) {
        return Err("Minecraft asset index checksum did not match.".into());
    }
    parse_index(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reuses_the_launcher_language_offline_after_caching() {
        tauri::async_runtime::block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let game = temp.path().join(".minecraft");
            let cache = temp.path().join("cache");
            let version = "26.3";
            let language = r#"{"block.minecraft.stone":"石头","menu.done":"完成","block.minecraft.empty":" "}"#.as_bytes();
            let hash = format!("{:x}", Sha1::digest(language));
            let index = serde_json::to_vec(&json!({
                "objects": { "minecraft/lang/zh_cn.json": { "hash": hash, "size": language.len() } }
            }))
            .unwrap();
            let metadata = serde_json::to_vec(&json!({ "assetIndex": {
                "id": "34", "url": "https://piston-meta.mojang.com/index.json",
                "sha1": format!("{:x}", Sha1::digest(&index)), "size": index.len()
            }}))
            .unwrap();
            for (path, bytes) in [
                (game.join("versions/26.3/26.3.json"), metadata.as_slice()),
                (game.join("assets/indexes/34.json"), index.as_slice()),
                (
                    game.join(format!("assets/objects/{}/{hash}", &hash[..2])),
                    language,
                ),
            ] {
                fs::create_dir_all(path.parent().unwrap()).await.unwrap();
                fs::write(path, bytes).await.unwrap();
            }

            let loader = MinecraftLanguages {
                cache: cache.clone(),
                game_roots: vec![game],
                neoform: None,
            };
            let loaded = loader.load(version, "zh_cn").await.unwrap();
            assert!(!loaded.unavailable);
            assert_eq!(loaded.locales, ["zh_cn"]);
            assert_eq!(
                loaded.labels,
                BTreeMap::from([("block.minecraft.stone".into(), "石头".into())])
            );

            let offline = MinecraftLanguages {
                cache,
                game_roots: vec![],
                neoform: None,
            };
            assert_eq!(
                offline.load(version, "zh_cn").await.unwrap().labels,
                loaded.labels
            );
            let missing = offline.load(version, "en_us").await.unwrap();
            assert!(!missing.unavailable && missing.labels.is_empty());
        });
    }
}
