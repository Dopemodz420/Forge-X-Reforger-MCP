/**
 * EMCP_WB_ProjectInfo.c - Project metadata + resource search
 *
 * Actions:
 *   guid    - generate a globally unique 64-bit resource id
 *   project - absolute path of the active game project file + cwd
 *   search  - search the resource database by filter
 *
 * Uses ResourceDatabase.SearchResources() rather than Workbench.SearchResources(),
 * which is marked [Obsolete] in GameLib/generated/WorkbenchAPI/Workbench.c.
 * The result-collection idiom (array.Insert passed straight as the callback) is
 * the same one the base game ships in WorkbenchGameCommon/ResourceInfo.c
 * (GetGameMaterials).
 *
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_ProjectInfo"
 */

class EMCP_WB_ProjectInfoRequest : JsonApiStruct
{
	string action;
	string rootPath;
	ref array<string> fileExtensions = {};
	ref array<string> searchStr = {};
	bool recursive;
	int limit;

	void EMCP_WB_ProjectInfoRequest()
	{
		RegAll();
	}
}

class EMCP_WB_ProjectInfoResponse : JsonApiStruct
{
	string status;
	string message;
	string action;

	// action = guid
	string guid;

	// action = project
	string projectFile;
	string cwd;

	// action = search
	int entryCount;
	bool truncated;
	ref array<ResourceName> entries = {};

	void EMCP_WB_ProjectInfoResponse()
	{
		RegAll();
	}
}

class EMCP_WB_ProjectInfo : NetApiHandler
{
	//----------------------------------------------------------------------------------------------
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ProjectInfoRequest();
	}

	//----------------------------------------------------------------------------------------------
	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ProjectInfoRequest req = EMCP_WB_ProjectInfoRequest.Cast(request);
		EMCP_WB_ProjectInfoResponse resp = new EMCP_WB_ProjectInfoResponse();
		resp.action = req.action;

		if (req.action == "guid")
		{
			resp.guid = Workbench.GenerateGloballyUniqueID64();
			resp.status = "ok";
			resp.message = "Generated globally unique id";
			return resp;
		}

		if (req.action == "project")
		{
			resp.projectFile = Workbench.GetCurrentGameProjectFile();

			string cwd;
			Workbench.GetCwd(cwd);
			resp.cwd = cwd;

			if (resp.projectFile == "")
			{
				resp.status = "error";
				resp.message = "No game project file reported by Workbench (is a project open?)";
			}
			else
			{
				resp.status = "ok";
				resp.message = "Active game project file resolved";
			}
			return resp;
		}

		if (req.action == "search")
		{
			SearchResourcesFilter filter = new SearchResourcesFilter();
			filter.rootPath = req.rootPath;

			if (req.fileExtensions.Count() > 0)
				filter.fileExtensions = req.fileExtensions;
			if (req.searchStr.Count() > 0)
				filter.searchStr = req.searchStr;

			// SearchResourcesFilter.recursive defaults to true. Assign unconditionally so
			// an absent/false value cannot silently turn a deep search into a flat one.
			filter.recursive = req.recursive;

			array<ResourceName> found = {};
			ResourceDatabase.SearchResources(filter, found.Insert);

			int total = found.Count();
			resp.entryCount = total;

			// Cap what we serialise — the resource database can hold six figures of
			// entries, which would otherwise overrun the NET API payload limit.
			int send = total;
			if (req.limit > 0 && total > req.limit)
			{
				send = req.limit;
				resp.truncated = true;
			}

			for (int i = 0; i < send; i++)
			{
				resp.entries.Insert(found[i]);
			}

			resp.status = "ok";
			if (total == 0)
				resp.message = "No resources matched the filter";
			else if (resp.truncated)
				resp.message = string.Format("Found %1 resources, returning first %2", total, send);
			else
				resp.message = string.Format("Found %1 resources", total);
			return resp;
		}

		resp.status = "error";
		resp.message = "Unknown action: " + req.action + ". Valid: guid, project, search";
		return resp;
	}
}
