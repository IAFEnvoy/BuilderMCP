use super::{PlacedBlock, SceneBlockState, nbt_compound, nbt_list};
use nucleation::nbt::{NbtMap, NbtValue};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock};

const MAX_LAYERS: usize = 16;
const MODERN_PATTERN_VERSION: i32 = 3837;
const DYES: [&str; 16] = [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black",
];
static LEGACY_PATTERNS: LazyLock<HashMap<&str, &str>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/banner-patterns.json"))
        .expect("legacy banner pattern IDs")
});

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum BlockEntityData {
    Banner(Banner),
    Jigsaw(Jigsaw),
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Banner {
    patterns: Vec<BannerLayer>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct BannerLayer {
    pattern: String,
    color: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Jigsaw {
    name: String,
    target: String,
    pool: String,
    final_state: String,
    joint: Joint,
    selection_priority: i32,
    placement_priority: i32,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Joint {
    Aligned,
    Rollable,
}

impl Joint {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Aligned => "aligned",
            Self::Rollable => "rollable",
        }
    }
}

fn banner(name: &str) -> bool {
    name.strip_prefix("minecraft:")
        .and_then(|name| name.strip_suffix("_banner"))
        .is_some_and(|name| DYES.contains(&name.strip_suffix("_wall").unwrap_or(name)))
}

fn resource_id(value: &str) -> Option<String> {
    let (namespace, path) = value.split_once(':').unwrap_or(("minecraft", value));
    let valid_char = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_.-".contains(&c);
    (namespace.len() + path.len() < 256
        && !namespace.is_empty()
        && !path.is_empty()
        && namespace.bytes().all(valid_char)
        && path.bytes().all(|c| valid_char(c) || c == b'/'))
    .then(|| format!("{namespace}:{path}"))
}

fn valid_final_state(value: &str) -> bool {
    !value.trim().is_empty()
        && value.encode_utf16().count() <= 2048
        && !value.contains(['\0', '\r', '\n'])
}

fn get_string<'a>(tag: &'a NbtMap, key: &str) -> Option<&'a str> {
    tag.get(key)
        .and_then(NbtValue::as_string)
        .map(String::as_str)
}

impl Jigsaw {
    fn from_nbt(state: &SceneBlockState, tag: Option<&NbtMap>) -> Self {
        let string = |key| tag.and_then(|tag| get_string(tag, key));
        let id = |key| {
            string(key)
                .and_then(resource_id)
                .unwrap_or_else(|| "minecraft:empty".into())
        };
        let priority = |key| {
            tag.and_then(|tag| tag.get(key))
                .and_then(NbtValue::as_i32)
                .unwrap_or(0)
        };
        let joint = match string("joint") {
            Some("aligned") => Joint::Aligned,
            Some("rollable") => Joint::Rollable,
            _ if state
                .properties
                .get("orientation")
                .is_some_and(|value| value.starts_with("up_") || value.starts_with("down_")) =>
            {
                Joint::Rollable
            }
            _ => Joint::Aligned,
        };
        Self {
            name: id("name"),
            target: id("target"),
            pool: id("pool"),
            final_state: string("final_state")
                .filter(|value| valid_final_state(value))
                .unwrap_or("minecraft:air")
                .trim()
                .into(),
            joint,
            selection_priority: priority("selection_priority"),
            placement_priority: priority("placement_priority"),
        }
    }

    fn to_nbt(&self) -> Result<NbtMap, String> {
        let id = |value| {
            resource_id(value)
                .map(NbtValue::String)
                .ok_or("拼图方块的资源 ID 无效。")
        };
        if !valid_final_state(&self.final_state) {
            return Err("拼图方块的替换方块状态无效。".into());
        }
        Ok(nbt_compound([
            ("name", id(&self.name)?),
            ("target", id(&self.target)?),
            ("pool", id(&self.pool)?),
            (
                "final_state",
                NbtValue::String(self.final_state.trim().into()),
            ),
            ("joint", NbtValue::String(self.joint.as_str().into())),
            ("selection_priority", NbtValue::Int(self.selection_priority)),
            ("placement_priority", NbtValue::Int(self.placement_priority)),
        ]))
    }
}

fn read_layer(tag: &NbtValue) -> Option<BannerLayer> {
    let tag = tag.as_compound()?;
    let pattern = match get_string(tag, "pattern") {
        Some(value) => resource_id(value)?,
        None => resource_id(LEGACY_PATTERNS.get(get_string(tag, "Pattern")?)?)?,
    };
    let legacy_color = || {
        let color = tag.get("Color").and_then(NbtValue::as_i32)?;
        DYES.get(usize::try_from(color).ok()?).copied()
    };
    let color = get_string(tag, "color")
        .or_else(legacy_color)
        .filter(|color| DYES.contains(color))
        .unwrap_or("white");
    Some(BannerLayer {
        pattern,
        color: color.into(),
    })
}

pub(super) fn read(state: &SceneBlockState, tag: &NbtMap) -> Option<Box<BlockEntityData>> {
    if banner(&state.name) {
        let patterns: Vec<_> = tag
            .get("patterns")
            .or_else(|| tag.get("Patterns"))
            .and_then(nbt_list)?
            .iter()
            .filter_map(read_layer)
            .take(MAX_LAYERS)
            .collect();
        if !patterns.is_empty() {
            return Some(Box::new(BlockEntityData::Banner(Banner { patterns })));
        }
    } else if state.name == "minecraft:jigsaw" {
        return Some(Box::new(BlockEntityData::Jigsaw(Jigsaw::from_nbt(
            state,
            Some(tag),
        ))));
    }
    None
}

fn write_banner(banner: &Banner, data_version: i32) -> Result<NbtMap, String> {
    if banner.patterns.len() > MAX_LAYERS {
        return Err("旗帜最多支持 16 层图案。".into());
    }
    let modern = data_version >= MODERN_PATTERN_VERSION;
    let mut patterns = Vec::with_capacity(banner.patterns.len());
    for layer in &banner.patterns {
        let pattern = resource_id(&layer.pattern).ok_or("旗帜图案的资源 ID 无效。")?;
        let dye = DYES
            .iter()
            .position(|&dye| dye == layer.color)
            .ok_or("旗帜图案的染料颜色无效。")?;
        let tag = if modern {
            nbt_compound([
                ("pattern", NbtValue::String(pattern)),
                ("color", NbtValue::String(layer.color.clone())),
            ])
        } else {
            let short = pattern
                .strip_prefix("minecraft:")
                .and_then(|pattern| {
                    LEGACY_PATTERNS
                        .iter()
                        .find_map(|(&short, &name)| (name == pattern).then_some(short))
                })
                .ok_or_else(|| format!("目标 Java 版本没有旗帜图案 {pattern}。"))?;
            nbt_compound([
                ("Pattern", NbtValue::String(short.into())),
                ("Color", NbtValue::Int(dye as i32)),
            ])
        };
        patterns.push(NbtValue::Compound(tag));
    }
    Ok(nbt_compound([(
        if modern { "patterns" } else { "Patterns" },
        NbtValue::List(patterns),
    )]))
}

pub(super) fn write(
    block: &PlacedBlock,
    data_version: i32,
) -> Result<Option<(&'static str, NbtMap)>, String> {
    let entity = match block.block_entity.as_deref() {
        Some(BlockEntityData::Banner(data)) if banner(&block.state.name) => {
            ("minecraft:banner", write_banner(data, data_version)?)
        }
        Some(BlockEntityData::Jigsaw(data)) if block.state.name == "minecraft:jigsaw" => {
            ("minecraft:jigsaw", data.to_nbt()?)
        }
        Some(_) => return Err("方块与方块实体的数据类型不一致。".into()),
        None if block.state.name == "minecraft:jigsaw" => (
            "minecraft:jigsaw",
            Jigsaw::from_nbt(&block.state, None).to_nbt()?,
        ),
        None => return Ok(None),
    };
    Ok(Some(entity))
}
