use flate2::{Compression, bufread::GzDecoder, write::GzEncoder};
use nucleation::{
    BlockState, Region, UniversalSchematic,
    dataconverter::block_state_keys,
    formats::{
        limits::DecodeLimits,
        litematic::{from_litematic_bounded, to_litematic_with_compression},
    },
    nbt::{
        Endian, NbtMap, NbtValue,
        io::{NbtReadLimits, read_nbt_with_limits, write_nbt},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::{self, BufWriter, Cursor, Read, Write},
};

mod bedrock;

pub const MAX_STRUCTURE_BYTES: usize = 128 * 1024 * 1024;
const MAX_BLOCKS: usize = 200_000;
const MAX_COORDINATE: i32 = 1_000_000;
const MAX_LITEMATIC_VOLUME: usize = 16_000_000;
const DEFAULT_DATA_VERSION: i32 = 3955;
const DEFAULT_NAME: &str = "未命名建筑";
const BUILDER_METADATA_TAG: &str = "BuilderMCP";
const NBT_LIMITS: NbtReadLimits = NbtReadLimits {
    max_depth: 128,
    max_string_bytes: u16::MAX as usize,
    max_collection_items: MAX_STRUCTURE_BYTES / 8,
    max_nodes: 4_000_000,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StructureFormat {
    Nbt,
    Litematic,
    Mcstructure,
}

impl StructureFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Nbt => "nbt",
            Self::Litematic => "litematic",
            Self::Mcstructure => "mcstructure",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    version: u8,
    name: String,
    data_version: i32,
    blocks: Vec<PlacedBlock>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct PlacedBlock {
    pos: [i32; 3],
    state: SceneBlockState,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
struct SceneBlockState {
    name: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    properties: BTreeMap<String, String>,
}

impl SceneBlockState {
    fn from_parts(mut name: String, properties: BTreeMap<String, String>) -> Result<Self, String> {
        if !name.contains(':') {
            name = format!("minecraft:{name}");
        }
        let state = Self { name, properties };
        state.validate()?;
        Ok(state)
    }

    fn validate(&self) -> Result<(), String> {
        let valid_char =
            |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_.-".contains(&c);
        let property_path = |name: &str| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        };
        let valid_id = self.name.split_once(':').is_some_and(|(namespace, path)| {
            !namespace.is_empty()
                && !path.is_empty()
                && namespace.bytes().all(valid_char)
                && path.bytes().all(|c| valid_char(c) || c == b'/')
        });
        if !valid_id || self.name.len() > 256 {
            return Err(format!("无效的方块 ID：{}", self.name));
        }
        if self.properties.len() > 32 {
            return Err("方块状态最多包含 32 个属性。".into());
        }
        for (key, value) in &self.properties {
            let valid_key = key.split_once(':').map_or_else(
                || property_path(key),
                |(namespace, path)| {
                    !namespace.is_empty()
                        && namespace.bytes().all(valid_char)
                        && !path.is_empty()
                        && path.bytes().all(valid_char)
                },
            );
            if !valid_key
                || key.len() > 64
                || value.is_empty()
                || value.len() > 64
                || !value.bytes().all(valid_char)
            {
                return Err(format!("无效的方块状态属性：{key}"));
            }
        }
        Ok(())
    }

    fn is_air(&self) -> bool {
        matches!(
            self.name.as_str(),
            "minecraft:air" | "minecraft:cave_air" | "minecraft:void_air"
        )
    }

    fn to_nucleation(&self) -> BlockState {
        BlockState::new(self.name.as_str()).with_properties(
            self.properties
                .iter()
                .map(|(key, value)| (key.as_str().into(), value.as_str().into()))
                .collect(),
        )
    }

    fn from_nucleation(state: BlockState) -> Result<Self, String> {
        Self::from_parts(
            state.name.to_string(),
            state
                .properties
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }
}

fn project_name(label: Option<&str>, filename: &str) -> String {
    let label = label
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(filename.trim());
    // The editor's name limit is measured in JavaScript UTF-16 code units.
    let mut units = 0;
    let name: String = label
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= 120
        })
        .collect();
    let name = name.trim();
    if name.is_empty() {
        DEFAULT_NAME.into()
    } else {
        name.into()
    }
}

fn check_position(pos: [i32; 3]) -> Result<(), String> {
    if pos
        .iter()
        .any(|n| !(-MAX_COORDINATE..=MAX_COORDINATE).contains(n))
    {
        return Err("方块坐标需要三个整数，每项在 ±1000000 以内。".into());
    }
    Ok(())
}

fn add_block(
    blocks: &mut HashMap<[i32; 3], SceneBlockState>,
    pos: [i32; 3],
    state: &SceneBlockState,
) -> Result<(), String> {
    if !state.is_air() {
        check_position(pos)?;
        blocks.insert(pos, state.clone());
        if blocks.len() > MAX_BLOCKS {
            return Err("结构的方块数量超过编辑器上限。".into());
        }
    }
    Ok(())
}

fn nbt_list(tag: &NbtValue) -> Option<&[NbtValue]> {
    match tag {
        NbtValue::List(items) => Some(items),
        _ => None,
    }
}

fn nbt_position(tag: &NbtValue) -> Option<[i32; 3]> {
    let [x, y, z] = nbt_list(tag)? else {
        return None;
    };
    Some([x.as_i32()?, y.as_i32()?, z.as_i32()?])
}

fn nbt_compound<const N: usize>(entries: [(&str, NbtValue); N]) -> NbtMap {
    let mut tag = NbtMap::new();
    for (key, value) in entries {
        tag.insert(key.into(), value);
    }
    tag
}

fn nbt_vector(pos: [i32; 3]) -> NbtValue {
    NbtValue::List(pos.into_iter().map(NbtValue::Int).collect())
}

fn builder_metadata(blocks: &[&PlacedBlock]) -> NbtMap {
    let namespaces: BTreeSet<_> = blocks
        .iter()
        .filter_map(|block| {
            block
                .state
                .name
                .split_once(':')
                .map(|(namespace, _)| namespace)
        })
        .collect();
    let namespaces = namespaces
        .into_iter()
        .map(|namespace| NbtValue::String(namespace.into()))
        .collect();
    nbt_compound([
        (
            "SoftwareVersion",
            NbtValue::String(env!("CARGO_PKG_VERSION").into()),
        ),
        ("BlockNamespaces", NbtValue::List(namespaces)),
    ])
}

fn read_state(tag: &NbtValue) -> Result<SceneBlockState, String> {
    let invalid = "方块调色板包含无效的状态。";
    let state = tag.as_compound().ok_or(invalid)?;
    let (name, properties) = if let Some(name) = state.get("Name").and_then(NbtValue::as_string) {
        (name, state.get("Properties"))
    } else {
        let name = state
            .get("id")
            .and_then(NbtValue::as_string)
            .ok_or(invalid)?;
        (name, state.get("properties"))
    };
    let mut result = BTreeMap::new();
    if let Some(properties) = properties {
        for (key, value) in properties.as_compound().ok_or(invalid)?.iter() {
            result.insert(key.clone(), value.as_string().ok_or(invalid)?.clone());
        }
    }
    SceneBlockState::from_parts(name.clone(), result)
}

fn write_state(state: &SceneBlockState, data_version: i32) -> NbtValue {
    let (name_key, properties_key) = block_state_keys(data_version);
    let mut tag = nbt_compound([(name_key, NbtValue::String(state.name.clone()))]);
    if !state.properties.is_empty() {
        let mut properties = NbtMap::new();
        for (key, value) in &state.properties {
            properties.insert(key.clone(), NbtValue::String(value.clone()));
        }
        tag.insert(properties_key.into(), NbtValue::Compound(properties));
    }
    NbtValue::Compound(tag)
}

fn read_java_nbt(bytes: &[u8]) -> Result<NbtMap, String> {
    let mut raw = Vec::new();
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes);
        (&mut decoder)
            .take(MAX_STRUCTURE_BYTES as u64 + 1)
            .read_to_end(&mut raw)
            .map_err(|error| format!("结构文件的 GZIP 数据损坏。{error}"))?;
        if raw.len() > MAX_STRUCTURE_BYTES {
            return Err("结构文件解压后超过 128 MiB。".into());
        }
        if !decoder.get_ref().is_empty() {
            return Err("GZIP 数据后包含多余的内容。".into());
        }
        raw.as_slice()
    } else {
        bytes
    };
    let mut reader = Cursor::new(bytes);
    let root = read_nbt_with_limits(&mut reader, Endian::Big, NBT_LIMITS)
        .map_err(|error| format!("无法读取 Java NBT。{error}"))?;
    if reader.position() != bytes.len() as u64 {
        return Err("NBT 根标签后包含多余的数据。".into());
    }
    match root {
        NbtValue::Compound(root) => Ok(root),
        _ => Err("文件不是 Java 版 NBT 结构。".into()),
    }
}

fn decode_java(
    data: &[u8],
    blocks: &mut HashMap<[i32; 3], SceneBlockState>,
) -> Result<Option<i32>, String> {
    let root = read_java_nbt(data)?;
    let invalid = "文件不是有效的 Minecraft Java 版原版结构。";
    let size = root.get("size").and_then(nbt_position).ok_or(invalid)?;
    if size.iter().any(|&dimension| dimension < 0) {
        return Err(invalid.into());
    }
    let entries = root.get("blocks").and_then(nbt_list).ok_or(invalid)?;
    let palette = root
        .get("palette")
        .or_else(|| root.get("palettes").and_then(nbt_list)?.first())
        .and_then(nbt_list)
        .ok_or("结构文件缺少有效的方块调色板。")?;
    let palette = palette
        .iter()
        .map(read_state)
        .collect::<Result<Vec<_>, _>>()?;
    for entry in entries {
        let entry = entry.as_compound().ok_or(invalid)?;
        let pos = entry
            .get("pos")
            .and_then(nbt_position)
            .filter(|pos| {
                pos.iter()
                    .zip(size)
                    .all(|(&n, dimension)| (0..dimension).contains(&n))
            })
            .ok_or("结构中有方块的坐标超出文件声明的尺寸。")?;
        let state = entry
            .get("state")
            .and_then(NbtValue::as_i32)
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| palette.get(index))
            .ok_or("结构引用了无效的方块索引。")?;
        add_block(blocks, pos, state)?;
    }
    root.get("DataVersion")
        .map(|tag| {
            tag.as_i32()
                .ok_or_else(|| "结构文件中的 DataVersion 无效。".into())
        })
        .transpose()
}

fn decode_litematic(
    data: &[u8],
    blocks: &mut HashMap<[i32; 3], SceneBlockState>,
) -> Result<(Option<String>, Option<i32>), String> {
    let limits = structure_limits(MAX_LITEMATIC_VOLUME, NBT_LIMITS);
    // The crate accepts gzip for this format. Also accept raw NBT from older workflows.
    let compressed;
    let data = if data.first() == Some(&10) {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(data).map_err(|error| error.to_string())?;
        compressed = encoder.finish().map_err(|error| error.to_string())?;
        compressed.as_slice()
    } else {
        data
    };
    let schematic = from_litematic_bounded(data, &limits)
        .map_err(|error| format!("无法读取 Litematica 文件（GZIP / NBT）。{error}"))?;
    // NBT compounds are unordered. Resolve overlaps consistently by region name.
    let mut regions: Vec<_> = schematic.get_all_regions().into_iter().collect();
    regions.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
    for (_, region) in regions {
        add_region_blocks(region, [0; 3], blocks)?;
    }
    Ok((schematic.metadata.name, schematic.metadata.mc_version))
}

fn structure_limits(max_volume: usize, nbt: NbtReadLimits) -> DecodeLimits {
    DecodeLimits {
        max_input_bytes: MAX_STRUCTURE_BYTES,
        max_decompressed_bytes: MAX_STRUCTURE_BYTES,
        max_dimension: max_volume,
        max_volume,
        max_nbt_depth: nbt.max_depth,
        max_nbt_string_bytes: nbt.max_string_bytes,
        max_nbt_collection_items: nbt.max_collection_items,
        max_nbt_nodes: nbt.max_nodes,
        ..DecodeLimits::default()
    }
}

fn add_region_blocks(
    region: &Region,
    offset: [i32; 3],
    blocks: &mut HashMap<[i32; 3], SceneBlockState>,
) -> Result<(), String> {
    let palette = region
        .get_palette()
        .into_iter()
        .map(SceneBlockState::from_nucleation)
        .collect::<Result<Vec<_>, _>>()?;
    // Nucleation's row iterator increments X after visiting the last cell.
    if region
        .get_tight_bounds()
        .is_some_and(|bounds| bounds.max.0 == i32::MAX)
    {
        return Err("方块坐标超出编辑器上限。".into());
    }
    for ((x, y, z), index) in region.content_cells() {
        let pos = [x, y, z];
        let mut placed = [0; 3];
        for axis in 0..3 {
            placed[axis] = pos[axis]
                .checked_add(offset[axis])
                .ok_or("方块坐标超出编辑器上限。")?;
        }
        add_block(blocks, placed, &palette[index as usize])?;
    }
    Ok(())
}

pub fn decode(data: &[u8], format: StructureFormat, filename: &str) -> Result<Structure, String> {
    if data.len() > MAX_STRUCTURE_BYTES {
        return Err("结构文件超过 128 MiB。".into());
    }
    let mut blocks = HashMap::new();
    let (label, data_version) = match format {
        StructureFormat::Nbt => (None, decode_java(data, &mut blocks)?),
        StructureFormat::Litematic => decode_litematic(data, &mut blocks)?,
        StructureFormat::Mcstructure => bedrock::decode(data, &mut blocks)?,
    };
    let mut blocks: Vec<_> = blocks
        .into_iter()
        .map(|(pos, state)| PlacedBlock { pos, state })
        .collect();
    blocks.sort_unstable_by_key(|block| [block.pos[1], block.pos[2], block.pos[0]]);
    Ok(Structure {
        version: 1,
        name: project_name(label.as_deref(), filename),
        data_version: data_version
            .filter(|&version| version > 0)
            .unwrap_or(DEFAULT_DATA_VERSION),
        blocks,
    })
}

fn encode_java(
    data_version: i32,
    blocks: &[&PlacedBlock],
    offset: [i32; 3],
    size: [i32; 3],
) -> Result<Vec<u8>, String> {
    let mut indices = HashMap::new();
    let mut palette = Vec::new();
    let mut entries = Vec::with_capacity(blocks.len());
    for block in blocks {
        let index = *indices.entry(&block.state).or_insert_with(|| {
            let index = palette.len() as i32;
            palette.push(write_state(&block.state, data_version));
            index
        });
        let pos = std::array::from_fn(|axis| block.pos[axis] - offset[axis]);
        entries.push(NbtValue::Compound(nbt_compound([
            ("pos", nbt_vector(pos)),
            ("state", NbtValue::Int(index)),
        ])));
    }
    let root = nbt_compound([
        ("DataVersion", NbtValue::Int(data_version)),
        (
            BUILDER_METADATA_TAG,
            NbtValue::Compound(builder_metadata(blocks)),
        ),
        ("size", nbt_vector(size)),
        ("palette", NbtValue::List(palette)),
        ("blocks", NbtValue::List(entries)),
        ("entities", NbtValue::List(Vec::new())),
    ]);
    let mut writer = BufWriter::new(GzEncoder::new(Vec::new(), Compression::fast()));
    write_nbt(&mut writer, &root, "", Endian::Big).map_err(|error| error.to_string())?;
    let encoder = writer.into_inner().map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())
}

fn add_litematic_metadata(bytes: &[u8], metadata: &NbtMap) -> io::Result<Vec<u8>> {
    let mut input = GzDecoder::new(bytes);
    let mut header = [0; 3];
    input.read_exact(&mut header)?;
    let [tag, name_high, name_low] = header;
    if tag != 10 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Expected an NBT root compound",
        ));
    }
    let name_len = u16::from_be_bytes([name_high, name_low]);
    let mut root_name = vec![0; usize::from(name_len)];
    input.read_exact(&mut root_name)?;

    // Nucleation has no general Litematica metadata hook. A named NBT root
    // compound has the same encoding as a compound field in the root payload.
    let mut writer = BufWriter::new(GzEncoder::new(Vec::new(), Compression::new(3)));
    writer.write_all(&header)?;
    writer.write_all(&root_name)?;
    write_nbt(&mut writer, metadata, BUILDER_METADATA_TAG, Endian::Big)?;
    io::copy(&mut input, &mut writer)?;
    writer
        .into_inner()
        .map_err(|error| error.into_error())?
        .finish()
}

fn encode_litematic(
    project: &Structure,
    blocks: &[&PlacedBlock],
    offset: [i32; 3],
    origin: [i32; 3],
    size: [i32; 3],
) -> Result<Vec<u8>, String> {
    if size.into_iter().map(i64::from).product::<i64>() > MAX_LITEMATIC_VOLUME as i64 {
        return Err("投影的包围盒超过 1600 万格。".into());
    }
    let region = build_region(blocks, offset, origin, size)?;
    let mut schematic = UniversalSchematic::new(project.name.clone());
    schematic.metadata.author = Some("Builder MCP".into());
    schematic.metadata.mc_version = Some(project.data_version);
    schematic.add_region(region);
    let bytes = to_litematic_with_compression(&schematic, Compression::fast())
        .map_err(|error| error.to_string())?;
    add_litematic_metadata(&bytes, &builder_metadata(blocks)).map_err(|error| error.to_string())
}

fn build_region(
    blocks: &[&PlacedBlock],
    offset: [i32; 3],
    origin: [i32; 3],
    size: [i32; 3],
) -> Result<Region, String> {
    let [x, y, z] = origin;
    let [width, height, depth] = size;
    let mut region = Region::try_new("Main".into(), (x, y, z), (width, height, depth))?;
    let mut states = HashMap::new();
    for block in blocks {
        let state = states
            .entry(&block.state)
            .or_insert_with(|| block.state.to_nucleation());
        let [x, y, z] = std::array::from_fn(|axis| origin[axis] + block.pos[axis] - offset[axis]);
        region.set_block(x, y, z, state);
    }
    Ok(region)
}

pub fn encode(
    project: &Structure,
    format: StructureFormat,
    preserve_origin: bool,
) -> Result<Vec<u8>, String> {
    if project.version != 1 || project.blocks.len() > MAX_BLOCKS {
        return Err("项目格式不受支持，或方块数量超过上限。".into());
    }
    if project.name.trim().is_empty() || project.name.encode_utf16().count() > 120 {
        return Err("项目名称需要 1 至 120 个字符。".into());
    }
    if project.data_version <= 0 {
        return Err("DataVersion 必须是正整数。".into());
    }

    let mut blocks = Vec::with_capacity(project.blocks.len());
    for block in &project.blocks {
        check_position(block.pos)?;
        block.state.validate()?;
        if !block.state.is_air() {
            blocks.push(block);
        }
    }
    blocks.sort_unstable_by_key(|block| [block.pos[1], block.pos[2], block.pos[0]]);
    let first = blocks.first().map_or([0; 3], |block| block.pos);
    let (mut min, mut max) = (first, first);
    for block in &blocks {
        for axis in 0..3 {
            min[axis] = min[axis].min(block.pos[axis]);
            max[axis] = max[axis].max(block.pos[axis]);
        }
    }
    match format {
        StructureFormat::Nbt => {
            let offset = if preserve_origin {
                min.map(|n| n.min(0))
            } else {
                min
            };
            let size = std::array::from_fn(|axis| max[axis] - offset[axis] + 1);
            encode_java(project.data_version, &blocks, offset, size)
        }
        StructureFormat::Litematic => {
            let origin = if preserve_origin { min } else { [0; 3] };
            let size = std::array::from_fn(|axis| max[axis] - min[axis] + 1);
            encode_litematic(project, &blocks, min, origin, size)
        }
        StructureFormat::Mcstructure => {
            let origin = if preserve_origin { min } else { [0; 3] };
            let size = std::array::from_fn(|axis| max[axis] - min[axis] + 1);
            bedrock::encode(project, &blocks, min, origin, size)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> Structure {
        serde_json::from_value(json!({
            "version": 1,
            "name": "测试 🧱",
            "dataVersion": 3955,
            "blocks": [
                {"pos": [-5, 4, 3], "state": {"name": "test:stairs", "properties": {"facing": "east"}}},
                {"pos": [-2, 5, 8], "state": {"name": "test:floor"}}
            ]
        })).unwrap()
    }

    #[test]
    fn java_structures_keep_states_and_support_raw_nbt() {
        let mut expected = project();
        let bytes = encode(&expected, StructureFormat::Nbt, true).unwrap();
        expected.blocks[0].pos = [0, 4, 3];
        expected.blocks[1].pos = [3, 5, 8];
        let mut raw = Vec::new();
        GzDecoder::new(bytes.as_slice())
            .read_to_end(&mut raw)
            .unwrap();
        for data in [bytes, raw] {
            assert_eq!(
                decode(&data, StructureFormat::Nbt, &expected.name).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn litematic_save_keeps_origin_and_export_rebases() {
        let format = StructureFormat::Litematic;
        let mut expected = project();
        let saved = encode(&expected, format, true).unwrap();
        assert_eq!(decode(&saved, format, "fallback").unwrap(), expected);

        let exported = encode(&expected, format, false).unwrap();
        expected.blocks[0].pos = [0, 0, 0];
        expected.blocks[1].pos = [3, 1, 5];
        assert_eq!(decode(&exported, format, "fallback").unwrap(), expected);
    }

    #[test]
    fn structures_store_the_exporter_version_and_used_namespaces() {
        let mut fixture = project();
        fixture.blocks.push(PlacedBlock {
            pos: [-4, 4, 4],
            state: SceneBlockState::from_parts("create:casing".into(), BTreeMap::new()).unwrap(),
        });
        for format in [StructureFormat::Nbt, StructureFormat::Litematic] {
            let bytes = encode(&fixture, format, true).unwrap();
            let root = read_java_nbt(&bytes).unwrap();
            let metadata = root
                .get(BUILDER_METADATA_TAG)
                .unwrap()
                .as_compound()
                .unwrap();
            assert_eq!(
                metadata
                    .get("SoftwareVersion")
                    .unwrap()
                    .as_string()
                    .unwrap(),
                env!("CARGO_PKG_VERSION")
            );
            let namespaces = metadata.get("BlockNamespaces").and_then(nbt_list).unwrap();
            assert_eq!(
                namespaces
                    .iter()
                    .map(|tag| tag.as_string().unwrap())
                    .collect::<Vec<_>>(),
                ["create", "test"]
            );
        }
    }

    #[test]
    fn empty_structures_reopen_and_truncated_gzip_is_rejected() {
        let mut expected = project();
        expected.blocks.clear();
        for format in [StructureFormat::Nbt, StructureFormat::Litematic] {
            let data = encode(&expected, format, true).unwrap();
            assert_eq!(decode(&data, format, &expected.name).unwrap(), expected);
            let root = read_java_nbt(&data).unwrap();
            let metadata = root
                .get(BUILDER_METADATA_TAG)
                .unwrap()
                .as_compound()
                .unwrap();
            assert!(
                metadata
                    .get("BlockNamespaces")
                    .and_then(nbt_list)
                    .unwrap()
                    .is_empty()
            );
            assert!(decode(&data[..data.len() - 1], format, &expected.name).is_err());
        }
    }
}
