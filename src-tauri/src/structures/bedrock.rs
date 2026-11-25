use super::{
    BUILDER_METADATA_TAG, MAX_STRUCTURE_BYTES, NBT_LIMITS, PlacedBlock, SceneBlockState, Structure,
    add_region_blocks, build_region, builder_metadata, nbt_compound, nbt_list, nbt_position,
    nbt_vector, structure_limits,
};
use flate2::bufread::ZlibDecoder;
use nucleation::{
    UniversalSchematic,
    formats::mcstructure::{from_mcstructure_bounded, to_mcstructure},
    nbt::{
        Endian, NbtMap, NbtValue,
        io::{NbtReadLimits, read_nbt_with_limits, write_nbt},
    },
};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
};

const MAX_VOLUME: usize = 2_000_000;
const BEDROCK_NBT_LIMITS: NbtReadLimits = NbtReadLimits {
    max_nodes: NBT_LIMITS.max_nodes + 2 * MAX_VOLUME,
    ..NBT_LIMITS
};
// Version of the Bedrock state palette shipped by Nucleation.
const PALETTE_VERSION: i32 = 0x0115_3c21;
const INVALID: &str = "文件不是有效的基岩版 .mcstructure 结构。";

fn read_root(data: &[u8]) -> Result<NbtMap, String> {
    let mut reader = Cursor::new(data);
    let nbt = read_nbt_with_limits(&mut reader, Endian::Little, BEDROCK_NBT_LIMITS)
        .map_err(|error| format!("无法读取基岩版 NBT。{error}"))?;
    match nbt {
        NbtValue::Compound(root) if reader.position() == data.len() as u64 => Ok(root),
        _ => Err(INVALID.into()),
    }
}

fn write_root(root: &NbtMap) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    write_nbt(&mut bytes, root, "", Endian::Little).map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn compound_mut<'a>(tag: &'a mut NbtMap, key: &str) -> Result<&'a mut NbtMap, &'static str> {
    match tag.get_mut(key) {
        Some(NbtValue::Compound(value)) => Ok(value),
        _ => Err(INVALID),
    }
}

fn block_index([x, y, z]: [i32; 3], [_, height, depth]: [i32; 3]) -> usize {
    ((x * height + y) * depth + z) as usize
}

fn unpack_structure(root: &mut NbtMap, version: i32) -> Result<NbtMap, String> {
    let compression = root.get("compression").map_or(Some(0), NbtValue::as_i32);
    match (compression, root.remove("structure")) {
        (Some(0), Some(NbtValue::Compound(structure))) => Ok(structure),
        (Some(1), Some(NbtValue::ByteArray(bytes))) if version == 2 => {
            let compressed: Vec<u8> = bytes.into_iter().map(|byte| byte as u8).collect();
            let mut decoder = ZlibDecoder::new(compressed.as_slice());
            let mut raw = Vec::new();
            (&mut decoder)
                .take(MAX_STRUCTURE_BYTES as u64 + 1)
                .read_to_end(&mut raw)
                .map_err(|error| format!("基岩版结构的 zlib 数据损坏。{error}"))?;
            if raw.len() > MAX_STRUCTURE_BYTES {
                return Err("基岩版结构解压后超过 128 MiB。".into());
            }
            if !decoder.get_ref().is_empty() {
                return Err("zlib 数据后包含多余的内容。".into());
            }
            read_root(&raw)
        }
        _ => Err(INVALID.into()),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockLayer {
    Air,
    Water,
    Solid,
}

fn checked_indices(
    layer: NbtValue,
    version: i32,
    volume: usize,
    palette_len: usize,
) -> Result<Vec<NbtValue>, String> {
    let indices: Vec<_> = match (version, layer) {
        (1, NbtValue::List(indices)) => indices,
        (2, NbtValue::IntArray(indices)) if indices.len() == volume => {
            indices.into_iter().map(NbtValue::Int).collect()
        }
        _ => return Err(INVALID.into()),
    };
    if indices.len() != volume
        || indices.iter().any(|index| {
            !matches!(index, NbtValue::Int(index) if *index >= -1 && *index < palette_len as i32)
        })
    {
        return Err("基岩版结构包含无效的方块索引。".into());
    }
    Ok(indices)
}

fn normalize_layers(
    structure: &mut NbtMap,
    version: i32,
    volume: usize,
    palette: &[BlockLayer],
) -> Result<HashSet<usize>, String> {
    let Some(NbtValue::List(layers)) = structure.remove("block_indices") else {
        return Err(INVALID.into());
    };
    if !(1..=2).contains(&layers.len()) {
        return Err(INVALID.into());
    }
    let mut layers = layers.into_iter();
    let primary = checked_indices(layers.next().unwrap(), version, volume, palette.len())?;
    let mut waterlogged = HashSet::new();
    let secondary = if let Some(secondary) = layers.next() {
        let mut secondary = checked_indices(secondary, version, volume, palette.len())?;
        let classify = |tag: &NbtValue| {
            palette
                .get(tag.as_i32().unwrap() as usize)
                .copied()
                .unwrap_or(BlockLayer::Air)
        };
        for (index, (main, extra)) in primary.iter().zip(&mut secondary).enumerate() {
            if classify(main) == BlockLayer::Solid {
                if classify(extra) == BlockLayer::Water {
                    waterlogged.insert(index);
                } else {
                    *extra = NbtValue::Int(-1);
                }
            }
        }
        Some(NbtValue::List(secondary))
    } else {
        None
    };
    let mut normalized = vec![NbtValue::List(primary)];
    if let Some(secondary) = secondary {
        normalized.push(secondary);
    }
    structure.insert("block_indices".into(), NbtValue::List(normalized));
    Ok(waterlogged)
}

pub(super) fn decode(
    data: &[u8],
    blocks: &mut HashMap<[i32; 3], SceneBlockState>,
) -> Result<(Option<String>, Option<i32>), String> {
    let mut root = read_root(data)?;
    let version = match root.get("format_version") {
        Some(NbtValue::Int(version @ (1 | 2))) => *version,
        _ => return Err("不支持此 .mcstructure 格式版本。".into()),
    };
    let size = root.get("size").and_then(nbt_position).ok_or(INVALID)?;
    let limits = structure_limits(MAX_VOLUME, BEDROCK_NBT_LIMITS);
    let [x, y, z] = size.map(i64::from);
    let volume = limits
        .check_dimensions((x, y, z))
        .map_err(|_| "基岩版结构的尺寸无效或包围盒超过 200 万格。")?;
    let metadata = root
        .get(BUILDER_METADATA_TAG)
        .and_then(NbtValue::as_compound);
    let name = metadata
        .and_then(|meta| meta.get("Name"))
        .and_then(NbtValue::as_string)
        .cloned();
    let java_version = metadata
        .and_then(|meta| meta.get("JavaDataVersion"))
        .and_then(NbtValue::as_i32);
    // External files record the world's capture location. Reopen our project
    // saves at their original editor coordinates.
    let origin = if name.is_some() {
        root.get("structure_world_origin")
            .and_then(nbt_position)
            .ok_or(INVALID)?
    } else {
        [0; 3]
    };

    let mut structure = unpack_structure(&mut root, version)?;
    structure.remove("entities");
    let palette = compound_mut(compound_mut(&mut structure, "palette")?, "default")?;
    palette.remove("block_position_data");
    let palette = palette
        .get("block_palette")
        .and_then(nbt_list)
        .ok_or(INVALID)?;
    if palette.len() > limits.max_palette_entries {
        return Err("基岩版结构的方块调色板超过上限。".into());
    }
    let kinds = palette
        .iter()
        .map(|tag| {
            let entry = tag.as_compound().ok_or(INVALID)?;
            let name = entry
                .get("name")
                .and_then(NbtValue::as_string)
                .ok_or(INVALID)?;
            Ok(match name.as_str() {
                "air" | "minecraft:air" | "minecraft:cave_air" | "minecraft:void_air" => {
                    BlockLayer::Air
                }
                "water" | "flowing_water" | "minecraft:water" | "minecraft:flowing_water" => {
                    BlockLayer::Water
                }
                _ => BlockLayer::Solid,
            })
        })
        .collect::<Result<Vec<_>, &str>>()?;
    let waterlogged = normalize_layers(&mut structure, version, volume, &kinds)?;
    // Nucleation 0.12 reads v1 lists. Normalize the v2 layers before decoding.
    let data = write_root(&nbt_compound([
        ("format_version", NbtValue::Int(1)),
        ("size", nbt_vector(size)),
        ("structure", NbtValue::Compound(structure)),
    ]))?;
    let schematic = from_mcstructure_bounded(&data, &limits)
        .map_err(|error| format!("无法读取基岩版结构。{error}"))?;
    add_region_blocks(&schematic.default_region, origin, blocks)?;
    // A Bedrock dry block and a waterlogged block share a palette entry.
    for (pos, state) in blocks {
        let local = std::array::from_fn(|axis| pos[axis] - origin[axis]);
        if waterlogged.contains(&block_index(local, size)) {
            state.properties.insert("waterlogged".into(), "true".into());
        } else if state.name.starts_with("minecraft:")
            && let Some(value) = state.properties.get_mut("waterlogged")
        {
            *value = "false".into();
        }
    }
    Ok((name, java_version))
}

pub(super) fn encode(
    project: &Structure,
    blocks: &[&PlacedBlock],
    min: [i32; 3],
    origin: [i32; 3],
    size: [i32; 3],
) -> Result<Vec<u8>, String> {
    if size.into_iter().map(i64::from).product::<i64>() > MAX_VOLUME as i64 {
        return Err("基岩版结构的包围盒超过 200 万格。".into());
    }
    let region = build_region(blocks, min, [0; 3], size)?;
    let mut schematic = UniversalSchematic::new(project.name.clone());
    schematic.add_region(region);
    let data = to_mcstructure(&schematic).map_err(|error| error.to_string())?;
    let mut root = read_root(&data)?;
    let mut metadata = builder_metadata(blocks);
    metadata.insert("Name".into(), NbtValue::String(project.name.clone()));
    metadata.insert(
        "JavaDataVersion".into(),
        NbtValue::Int(project.data_version),
    );
    root.insert(BUILDER_METADATA_TAG.into(), NbtValue::Compound(metadata));
    root.insert("structure_world_origin".into(), nbt_vector(origin));

    let structure = compound_mut(&mut root, "structure")?;
    let palette = compound_mut(compound_mut(structure, "palette")?, "default")?;
    let Some(NbtValue::List(palette)) = palette.get_mut("block_palette") else {
        return Err(INVALID.into());
    };
    for entry in palette.iter_mut() {
        let NbtValue::Compound(entry) = entry else {
            return Err(INVALID.into());
        };
        entry.insert("version".into(), NbtValue::Int(PALETTE_VERSION));
    }
    let wet_blocks = blocks.iter().filter(|block| {
        block
            .state
            .properties
            .get("waterlogged")
            .is_some_and(|value| value == "true")
    });
    let mut wet_blocks = wet_blocks.peekable();
    if wet_blocks.peek().is_some() {
        let water = NbtValue::Compound(nbt_compound([
            ("name", NbtValue::String("minecraft:water".into())),
            (
                "states",
                NbtValue::Compound(nbt_compound([("liquid_depth", NbtValue::Int(0))])),
            ),
            ("version", NbtValue::Int(PALETTE_VERSION)),
        ]));
        let water_index = palette
            .iter()
            .position(|entry| *entry == water)
            .unwrap_or_else(|| {
                palette.push(water);
                palette.len() - 1
            });
        let Some(NbtValue::List(layers)) = structure.get_mut("block_indices") else {
            return Err(INVALID.into());
        };
        let [_, NbtValue::List(secondary)] = layers.as_mut_slice() else {
            return Err(INVALID.into());
        };
        for block in wet_blocks {
            let local = std::array::from_fn(|axis| block.pos[axis] - min[axis]);
            secondary[block_index(local, size)] = NbtValue::Int(water_index as i32);
        }
    }
    write_root(&root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structures::StructureFormat;
    use flate2::{Compression, write::ZlibEncoder};
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn bedrock_save_preserves_project_origin_and_dry_and_waterlogged_states() {
        let expected: Structure = serde_json::from_value(json!({
            "version": 1, "name": "基岩版 🧱", "dataVersion": 4671,
            "blocks": [
                {"pos": [-2, 3, 4], "state": {"name": "minecraft:oak_stairs", "properties": {
                    "facing": "east", "half": "bottom", "shape": "straight", "waterlogged": "false"
                }}},
                {"pos": [-1, 3, 4], "state": {"name": "minecraft:oak_stairs", "properties": {
                    "facing": "east", "half": "bottom", "shape": "straight", "waterlogged": "true"
                }}},
                {"pos": [0, 4, 5], "state": {"name": "addon:panel", "properties": {"addon:variant": "polished"}}}
            ]
        })).unwrap();
        let format = StructureFormat::Mcstructure;
        let data = super::super::encode(&expected, format, true).unwrap();
        assert_eq!(
            super::super::decode(&data, format, "fallback").unwrap(),
            expected
        );
        let root = read_root(&data).unwrap();
        assert_eq!(
            root.get("format_version").and_then(NbtValue::as_i32),
            Some(1)
        );
        let structure = root.get("structure").unwrap().as_compound().unwrap();
        let indices = structure.get("block_indices").and_then(nbt_list).unwrap();
        let secondary = nbt_list(&indices[1]).unwrap();
        assert_eq!(secondary[0], NbtValue::Int(-1));
        let water_index = secondary[4].as_i32().unwrap() as usize;
        let palette = structure
            .get("palette")
            .unwrap()
            .as_compound()
            .unwrap()
            .get("default")
            .unwrap()
            .as_compound()
            .unwrap()
            .get("block_palette")
            .and_then(nbt_list)
            .unwrap();
        let water = palette[water_index].as_compound().unwrap();
        assert_eq!(
            water.get("name"),
            Some(&NbtValue::String("minecraft:water".into()))
        );
        assert_eq!(water.get("version"), Some(&NbtValue::Int(PALETTE_VERSION)));

        let exported = super::super::encode(&expected, format, false).unwrap();
        let exported = super::super::decode(&exported, format, "fallback").unwrap();
        assert_eq!(
            exported.blocks.iter().map(|b| b.pos).collect::<Vec<_>>(),
            [[0, 0, 0], [1, 0, 0], [2, 1, 1]]
        );
        assert!(super::super::decode(&data[..data.len() - 1], format, "bad").is_err());
    }

    fn v2_structure(indices: Vec<i32>, compress: bool) -> Vec<u8> {
        let entry = nbt_compound([
            ("name", NbtValue::String("minecraft:oak_log".into())),
            (
                "states",
                NbtValue::Compound(nbt_compound([(
                    "pillar_axis",
                    NbtValue::String("x".into()),
                )])),
            ),
            ("version", NbtValue::Int(PALETTE_VERSION)),
        ]);
        let palette = nbt_compound([(
            "block_palette",
            NbtValue::List(vec![NbtValue::Compound(entry)]),
        )]);
        let structure = nbt_compound([
            (
                "block_indices",
                NbtValue::List(vec![NbtValue::IntArray(indices)]),
            ),
            (
                "palette",
                NbtValue::Compound(nbt_compound([("default", NbtValue::Compound(palette))])),
            ),
        ]);
        let payload = if compress {
            let mut zlib = ZlibEncoder::new(Vec::new(), Compression::fast());
            zlib.write_all(&write_root(&structure).unwrap()).unwrap();
            NbtValue::ByteArray(
                zlib.finish()
                    .unwrap()
                    .into_iter()
                    .map(|byte| byte as i8)
                    .collect(),
            )
        } else {
            NbtValue::Compound(structure)
        };
        write_root(&nbt_compound([
            ("format_version", NbtValue::Int(2)),
            ("compression", NbtValue::Int(i32::from(compress))),
            ("size", nbt_vector([2, 2, 2])),
            ("structure", payload),
            (
                "structure_world_origin",
                nbt_vector([1_500_000, 120, -1_500_000]),
            ),
        ]))
        .unwrap()
    }

    #[test]
    fn bedrock_v2_reads_int_arrays_and_zlib_and_validates_the_grid() {
        let format = StructureFormat::Mcstructure;
        for compress in [false, true] {
            let file = v2_structure(vec![-1, -1, -1, 0, -1, 0, -1, -1], compress);
            let project = super::super::decode(&file, format, "from game").unwrap();
            assert_eq!(project.name, "from game");
            assert_eq!(
                project.blocks.iter().map(|b| b.pos).collect::<Vec<_>>(),
                [[1, 0, 1], [0, 1, 1]]
            );
            for block in project.blocks {
                assert_eq!(block.state.name, "minecraft:oak_log");
                assert_eq!(
                    block.state.properties.get("axis").map(String::as_str),
                    Some("x")
                );
            }
            assert!(
                super::super::decode(&v2_structure(vec![0; 9], compress), format, "bad").is_err()
            );
            assert!(
                super::super::decode(&v2_structure(vec![1; 8], compress), format, "bad").is_err()
            );
        }
    }
}
