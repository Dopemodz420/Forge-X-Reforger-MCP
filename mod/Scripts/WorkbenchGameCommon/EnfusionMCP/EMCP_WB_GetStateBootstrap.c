/**
 * EMCP_WB_GetStateBootstrap.c - Launcher-aware state snapshot (WorkbenchGameCommon)
 *
 * Same bootstrap idea as PingBootstrap: lives in WorkbenchGameCommon so wb_state works
 * at the launcher. Distinct class name avoids duplicate when WorkbenchGame is also active.
 */

class EMCP_WB_GetStateBootstrapRequest : JsonApiStruct
{
	void EMCP_WB_GetStateBootstrapRequest()
	{
	}
}

class EMCP_WB_GetStateBootstrapResponse : JsonApiStruct
{
	string status;
	string message;
	string mode;
	int entityCount;
	int selectedCount;
	int currentSubScene;
	bool isPrefabEditMode;
	string boundsMin;
	string boundsMax;
	ref array<string> m_aSelectedNames;

	void EMCP_WB_GetStateBootstrapResponse()
	{
		RegV("status");
		RegV("message");
		RegV("mode");
		RegV("entityCount");
		RegV("selectedCount");
		RegV("currentSubScene");
		RegV("isPrefabEditMode");
		RegV("boundsMin");
		RegV("boundsMax");
		m_aSelectedNames = {};
	}

	override void OnPack()
	{
		StartArray("selectedNames");
		for (int i = 0; i < m_aSelectedNames.Count(); i++)
		{
			ItemString(m_aSelectedNames[i]);
		}
		EndArray();
	}
}

class EMCP_WB_GetStateBootstrap : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_GetStateBootstrapRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_GetStateBootstrapResponse resp = new EMCP_WB_GetStateBootstrapResponse();

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "ok";
			resp.mode = "no_world_editor";
			resp.message = "Bootstrap: WorldEditor module not loaded (launcher)";
			return resp;
		}

		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
		{
			resp.status = "ok";
			resp.mode = "game";
			resp.message = "Bootstrap: In game mode (WorldEditorAPI not available)";
			vector bMin, bMax;
			if (worldEditor.GetTerrainBounds(bMin, bMax))
			{
				resp.boundsMin = bMin[0].ToString() + " " + bMin[1].ToString() + " " + bMin[2].ToString();
				resp.boundsMax = bMax[0].ToString() + " " + bMax[1].ToString() + " " + bMax[2].ToString();
			}
			return resp;
		}

		resp.mode = "edit";
		resp.entityCount = api.GetEditorEntityCount();
		resp.selectedCount = api.GetSelectedEntitiesCount();
		resp.currentSubScene = api.GetCurrentSubScene();
		resp.isPrefabEditMode = worldEditor.IsPrefabEditMode();
		vector bMin2, bMax2;
		if (worldEditor.GetTerrainBounds(bMin2, bMax2))
		{
			resp.boundsMin = bMin2[0].ToString() + " " + bMin2[1].ToString() + " " + bMin2[2].ToString();
			resp.boundsMax = bMax2[0].ToString() + " " + bMax2[1].ToString() + " " + bMax2[2].ToString();
		}
		int maxSel = resp.selectedCount;
		if (maxSel > 50) maxSel = 50;
		for (int i = 0; i < maxSel; i++)
		{
			IEntitySource selSrc = api.GetSelectedEntity(i);
			if (selSrc) resp.m_aSelectedNames.Insert(selSrc.GetName());
			else resp.m_aSelectedNames.Insert("");
		}
		resp.status = "ok";
		resp.message = "Bootstrap state: " + resp.entityCount.ToString() + " entities, " + resp.selectedCount.ToString() + " selected";
		return resp;
	}
}
