import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGuidChunk, buildGuidIndex, CATALOG_GUID_PATTERN, REF_GUID_PATTERN } from "../../src/tools/asset-search.js";

describe("asset GUID mining", () => {
  let map: Map<string, string>;

  beforeEach(() => {
    map = new Map();
  });

  describe("scanGuidChunk", () => {
    it("extracts prefab GUIDs from entity catalog content", () => {
      const catalog = `SCR_EntityCatalogEntry "{60F68B7B1926C1E7}" {
        m_sEntityPrefab "{22E43956740A6794}Prefabs/Characters/Factions/CIV/Character_CIV_Randomized.et"
      }`;
      expect(scanGuidChunk(map, catalog, CATALOG_GUID_PATTERN)).toBe(1);
      expect(map.get("prefabs/characters/factions/civ/character_civ_randomized.et")).toBe("22E43956740A6794");
    });

    it("extracts layout GUIDs from chimeraMenus.conf content", () => {
      const menus = `MenuPreset MainMenu {
        Layout "{C5D8399074D02270}UI/layouts/Menus/MainMenu/MainMenu.layout"
        Class "MainMenuUI"
      }`;
      expect(scanGuidChunk(map, menus, REF_GUID_PATTERN)).toBe(1);
      expect(map.get("ui/layouts/menus/mainmenu/mainmenu.layout")).toBe("C5D8399074D02270");
    });

    it("extracts texture GUIDs from imageset content", () => {
      const imageset = `path "{403EEC9EC77AE359}UI/Textures/Icons/icons_mapMarkersUI-glow_atlas.edds"`;
      expect(scanGuidChunk(map, imageset, REF_GUID_PATTERN)).toBe(1);
      expect(map.get("ui/textures/icons/icons_mapmarkersui-glow_atlas.edds")).toBe("403EEC9EC77AE359");
    });

    it("ignores non-resource GUIDs (layout slot instance ids)", () => {
      const layout = `FrameWidgetClass "{5526A127AAA7B01}" {
        Slot FrameWidgetSlot "{516CFB71D6C6EEED}" {
          Anchor 0.5 0.5 0.5 0.5
        }
        Texture "{E23427CAC80DA8B7}UI/Textures/Icons/icons_mapMarkersUI.imageset"
      }`;
      // Slot/class GUIDs have no resource path after them — only the imageset ref counts.
      expect(scanGuidChunk(map, layout, REF_GUID_PATTERN)).toBe(1);
      expect(map.get("ui/textures/icons/icons_mapmarkersui.imageset")).toBe("E23427CAC80DA8B7");
      expect([...map.keys()]).toHaveLength(1);
    });

    it("normalizes backslashes and case", () => {
      scanGuidChunk(map, `{AABBCCDDEEFF0011}UI\\layouts\\Foo\\Bar.layout"`, REF_GUID_PATTERN);
      expect(map.get("ui/layouts/foo/bar.layout")).toBe("AABBCCDDEEFF0011");
    });

    it("does not duplicate existing entries", () => {
      map.set("prefabs/x.et", "1111111111111111");
      expect(scanGuidChunk(map, `{2222222222222222}Prefabs/X.et"`, CATALOG_GUID_PATTERN)).toBe(0);
      expect(map.get("prefabs/x.et")).toBe("1111111111111111");
    });
  });

  describe("buildGuidIndex", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "asset-guid-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("scans loose entity catalogs under basePath with no pak VFS", () => {
      const catDir = join(dir, "Configs", "EntityCatalog", "USMC");
      mkdirSync(catDir, { recursive: true });
      writeFileSync(
        join(catDir, "Characters_EntityCatalog_USMC.conf"),
        `m_sEntityPrefab "{AABBCCDDEEFF0011}Prefabs/Characters/Factions/USMC/Character_USMC.et"`
      );

      const { guidMap, diag } = buildGuidIndex(dir, null, []);
      expect(guidMap.get("prefabs/characters/factions/usmc/character_usmc.et")).toBe("AABBCCDDEEFF0011");
      expect(diag).toContain("1 catalogs");
    });
  });
});