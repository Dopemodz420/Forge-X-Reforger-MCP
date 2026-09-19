/**
 * EMCP_WB_PingBootstrap.c - Launcher-aware health check (WorkbenchGameCommon)
 *
 * Lives in WorkbenchGameCommon so it loads even when WorldEditor/WorkbenchGame is NOT active
 * (e.g. Workbench launcher screen). This lets wb_connect / wb_diagnose report "connected"
 * without needing WorldEditor open. Class name is distinct from EMCP_WB_Ping to avoid
 * duplicate-class compile when both WorkbenchGame and WorkbenchGameCommon are active.
 *
 * Client tries EMCP_WB_Ping first (WorkbenchGame), falls back to EMCP_WB_PingBootstrap here.
 */

class EMCP_WB_PingBootstrapRequest : JsonApiStruct
{
	void EMCP_WB_PingBootstrapRequest()
	{
	}
}

class EMCP_WB_PingBootstrapResponse : JsonApiStruct
{
	string status;
	string mode;
	string message;

	void EMCP_WB_PingBootstrapResponse()
	{
		RegV("status");
		RegV("mode");
		RegV("message");
	}
}

class EMCP_WB_PingBootstrap : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_PingBootstrapRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_PingBootstrapResponse resp = new EMCP_WB_PingBootstrapResponse();

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "ok";
			resp.mode = "no_world_editor";
			resp.message = "EnfusionMCP bootstrap active (launcher — open World Editor for entity tools)";
			return resp;
		}

		WorldEditorAPI api = worldEditor.GetApi();
		if (api)
		{
			resp.status = "ok";
			resp.mode = "edit";
			resp.message = "EnfusionMCP bootstrap active (edit mode)";
		}
		else
		{
			resp.status = "ok";
			resp.mode = "game";
			resp.message = "EnfusionMCP bootstrap active (game mode)";
		}

		return resp;
	}
}
