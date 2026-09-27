/**
 * EMCP_WB_Resources.c - Resource operations handler
 *
 * Actions: register, rebuild, open, browse
 * Uses the ResourceManager Workbench module.
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Resources"
 */

class EMCP_WB_ResourcesRequest : JsonApiStruct
{
	string action;
	string path;
	bool buildRuntime;

	void EMCP_WB_ResourcesRequest()
	{
		RegV("action");
		RegV("path");
		RegV("buildRuntime");
	}
}

class EMCP_WB_ResourcesResponse : JsonApiStruct
{
	string status;
	string message;
	string action;
	string path;
	int entryCount;
	bool truncated;
	// Named without the m_ prefix so RegAll() serialises it as "entries", matching
	// EMCP_WB_ProjectInfo — an m_-prefixed member is not emitted.
	ref array<ResourceName> entries = {};

	void EMCP_WB_ResourcesResponse()
	{
		RegAll();
	}
}

class EMCP_WB_Resources : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ResourcesRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ResourcesRequest req = EMCP_WB_ResourcesRequest.Cast(request);
		EMCP_WB_ResourcesResponse resp = new EMCP_WB_ResourcesResponse();
		resp.action = req.action;
		resp.path = req.path;

		if (req.path == "")
		{
			resp.status = "error";
			resp.message = "path parameter required";
			return resp;
		}

		ResourceManager resMgr = Workbench.GetModule(ResourceManager);
		if (!resMgr)
		{
			resp.status = "error";
			resp.message = "ResourceManager module not available";
			return resp;
		}

		if (req.action == "register")
		{
			bool result = resMgr.RegisterResourceFile(req.path, req.buildRuntime);
			resp.status = "ok";
			if (result)
				resp.message = "Resource registered: " + req.path;
			else
				resp.message = "RegisterResourceFile returned false for: " + req.path;
		}
		else if (req.action == "rebuild")
		{
			resMgr.RebuildResourceFile(req.path, "", false);
			resp.status = "ok";
			resp.message = "Rebuild initiated for: " + req.path;
		}
		else if (req.action == "open")
		{
			bool result = resMgr.SetOpenedResource(req.path);
			resp.status = "ok";
			if (result)
				resp.message = "Opened resource: " + req.path;
			else
				resp.message = "SetOpenedResource returned false for: " + req.path;
		}
		else if (req.action == "browse")
		{
			// Delegate to the resource database. Workbench.SearchResources() is
			// [Obsolete] (GameLib/generated/WorkbenchAPI/Workbench.c) — the supported
			// entry point is ResourceDatabase.SearchResources() with a
			// SearchResourcesFilter, whose callback is a typedef func (not a class).
			array<ResourceName> found = {};

			SearchResourcesFilter filter = new SearchResourcesFilter();
			filter.rootPath = req.path;
			filter.recursive = true;

			ResourceDatabase.SearchResources(filter, found.Insert);

			int total = found.Count();
			resp.entryCount = total;

			// Keep the response small — the database can hold six figures of entries.
			int send = total;
			if (total > 200)
			{
				send = 200;
				resp.truncated = true;
			}

			for (int i = 0; i < send; i++)
			{
				resp.entries.Insert(found[i]);
			}

			resp.status = "ok";
			if (total == 0)
				resp.message = "No resources found under: " + req.path;
			else if (total > send)
				resp.message = string.Format("Found %1 resources under %2, showing first %3", total, req.path, send);
			else
				resp.message = string.Format("Found %1 resources under %2", total, req.path);
		}
		else
		{
			resp.status = "error";
			resp.message = "Unknown action: " + req.action + ". Valid: register, rebuild, open, browse";
		}

		return resp;
	}
}
