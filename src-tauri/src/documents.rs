use crate::{
    file_io,
    structures::{self, MAX_STRUCTURE_BYTES, Structure, StructureFormat},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;
use uuid::Uuid;

#[derive(Serialize)]
pub struct OpenedStructure {
    path: PathBuf,
    format: StructureFormat,
    project: Structure,
}

#[derive(Serialize)]
pub struct SavedStructure {
    path: PathBuf,
    format: StructureFormat,
    bytes: usize,
}

fn structure_format(path: &Path) -> Result<StructureFormat, String> {
    if !path.is_absolute() {
        return Err("Provide an absolute path on the machine running Builder MCP.".into());
    }
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("nbt") => Ok(StructureFormat::Nbt),
        Some("litematic") => Ok(StructureFormat::Litematic),
        Some("mcstructure") => Ok(StructureFormat::Mcstructure),
        _ => Err("Choose a .nbt, .litematic, or .mcstructure file.".into()),
    }
}

pub fn write_document(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid save path.")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    staged
        .write_all(bytes)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    let saved = if overwrite {
        staged.persist(path)
    } else {
        staged.persist_noclobber(path)
    };
    saved.map(|_| ()).map_err(|error| {
        if !overwrite && error.error.kind() == io::ErrorKind::AlreadyExists {
            "The destination already exists. Set overwrite to true to replace it.".into()
        } else {
            error.to_string()
        }
    })
}

#[tauri::command]
pub async fn save_document(app: AppHandle, path: PathBuf, data: String) -> Result<(), String> {
    if !path.is_absolute() || !app.fs_scope().is_allowed(&path) {
        return Err("请通过保存对话框选择文件。".into());
    }
    file_io(move || {
        let bytes = STANDARD.decode(data).map_err(|error| error.to_string())?;
        write_document(&path, &bytes, true)
    })
    .await
}

#[tauri::command]
pub async fn read_structure_file(path: PathBuf) -> Result<OpenedStructure, String> {
    let format = structure_format(&path)?;
    file_io(move || {
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("The structure path must point to a file.".into());
        }
        if metadata.len() > MAX_STRUCTURE_BYTES as u64 {
            return Err("The structure file exceeds 128 MiB.".into());
        }
        let mut bytes = Vec::new();
        File::open(&path)
            .and_then(|file| {
                file.take(MAX_STRUCTURE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| error.to_string())?;
        let name = path.file_stem().unwrap_or_default().to_string_lossy();
        let project = structures::decode(&bytes, format, &name)?;
        Ok(OpenedStructure {
            path,
            format,
            project,
        })
    })
    .await
}

#[tauri::command]
pub async fn save_structure_file(
    app: AppHandle,
    path: Option<PathBuf>,
    format: StructureFormat,
    project: Structure,
    overwrite: bool,
    preserve_origin: bool,
) -> Result<SavedStructure, String> {
    let generate_path = path.is_none();
    let path = match path {
        Some(path) if structure_format(&path)? == format => path,
        Some(_) => {
            return Err("The file extension must match the selected structure format.".into());
        }
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("exports")
            .join(format!("build-{}.{}", Uuid::new_v4(), format.extension())),
    };
    file_io(move || {
        let bytes = structures::encode(&project, format, preserve_origin)?;
        if generate_path {
            fs::create_dir_all(path.parent().ok_or("Invalid save path.")?)
                .map_err(|error| error.to_string())?;
        }
        write_document(&path, &bytes, overwrite && !generate_path)?;
        Ok(SavedStructure {
            path,
            format,
            bytes: bytes.len(),
        })
    })
    .await
}
