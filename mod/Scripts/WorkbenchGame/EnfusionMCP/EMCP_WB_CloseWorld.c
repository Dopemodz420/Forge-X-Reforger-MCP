/**
 * EMCP_WB_CloseWorld.c - Close current world handler (fallback for safe reload)
 *
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_CloseWorld"
 * No parameters. Attempts to close the currently opened world to avoid
 * GameApp.cpp:1287 Resources are leaking assert on Reload Scripts.
 */

class EMCP_WB_CloseWorldRequest : JsonApiStruct
{
	void EMCP_WB_CloseWorldRequest()
	{
	}
}

class EMCP_WB_CloseWorldResponse : JsonApiStruct
{
	string status;
	string message;

	void EMCP_WB_CloseWorldResponse()
	{
		RegV("status");
		RegV("message");
	}
}

class EMCP_WB_CloseWorld : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_CloseWorldRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_CloseWorldResponse resp = new EMCP_WB_CloseWorldResponse();

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "error";
			resp.message = "WorldEditor module not available";
			return resp;
		}

		bool closed = worldEditor.SetOpenedResource("");
		if (!closed)
		{
			array<string> menuPath = {};
			menuPath.Insert("File");
			menuPath.Insert("Close");
			closed = worldEditor.ExecuteAction(menuPath);
		}
		if (!closed)
		{
			array<string> menuPath2 = {};
			menuPath2.Insert("File");
			menuPath2.Insert("Close World");
			closed = worldEditor.ExecuteAction(menuPath2);
		}

		resp.status = "ok";
		if (closed)
			resp.message = "Close world triggered";
		else
			resp.message = "Close world returned false — may already be closed";

		return resp;
	}
}
