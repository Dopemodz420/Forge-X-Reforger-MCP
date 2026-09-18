/**
 * EMCP_WB_SelectEntity.c - Selection management handler
 *
 * Actions: select, deselect, clear, getSelected
 * "select" replaces the current selection with the entity (SetEntitySelection).
 * "deselect" uses RemoveFromEntitySelection.
 * "clear" uses ClearEntitySelection.
 * "getSelected" iterates GetSelectedEntity.
 *
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_SelectEntity"
 */

class EMCP_WB_SelectEntityRequest : JsonApiStruct
{
	string action;
	string name;

	void EMCP_WB_SelectEntityRequest()
	{
		RegV("action");
		RegV("name");
	}
}

class EMCP_WB_SelectEntityResponse : JsonApiStruct
{
	string status;
	string message;
	string action;
	int selectedCount;

	// Selected entity names for getSelected
	ref array<string> m_aSelectedNames;
	ref array<string> m_aSelectedClasses;

	void EMCP_WB_SelectEntityResponse()
	{
		RegV("status");
		RegV("message");
		RegV("action");
		RegV("selectedCount");

		m_aSelectedNames = {};
		m_aSelectedClasses = {};
	}

	override void OnPack()
	{
		if (m_aSelectedNames.Count() > 0)
		{
			StartArray("selectedEntities");
			for (int i = 0; i < m_aSelectedNames.Count(); i++)
			{
				StartObject("");
				StoreString("name", m_aSelectedNames[i]);
				StoreString("className", m_aSelectedClasses[i]);
				EndObject();
			}
			EndArray();
		}
	}
}

class EMCP_WB_SelectEntity : NetApiHandler
{
	//------------------------------------------------------------------------------------------------
	static IEntitySource FindEntityByName(WorldEditorAPI api, string name)
	{
		int count = api.GetEditorEntityCount();
		for (int i = 0; i < count; i++)
		{
			IEntitySource candidate = api.GetEditorEntity(i);
			if (candidate && candidate.GetName() == name)
				return candidate;
		}
		return null;
	}

	//------------------------------------------------------------------------------------------------
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_SelectEntityRequest();
	}

	//------------------------------------------------------------------------------------------------
	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_SelectEntityRequest req = EMCP_WB_SelectEntityRequest.Cast(request);
		EMCP_WB_SelectEntityResponse resp = new EMCP_WB_SelectEntityResponse();
		resp.action = req.action;

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "error";
			resp.message = "WorldEditor module not available";
			return resp;
		}

		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
		{
			resp.status = "error";
			resp.message = "WorldEditorAPI not available";
			return resp;
		}

		if (req.action == "select")
		{
			if (req.name == "")
			{
				resp.status = "error";
				resp.message = "name parameter required for select action";
				return resp;
			}

			IEntitySource entSrc = FindEntityByName(api, req.name);
			if (!entSrc)
			{
				resp.status = "error";
				resp.message = "Entity not found: " + req.name;
				return resp;
			}

			// Replace the current selection with this entity.
			api.SetEntitySelection(entSrc);
			resp.selectedCount = api.GetSelectedEntitiesCount();
			resp.status = "ok";
			resp.message = "Entity selected: " + req.name + " (selection count: " + resp.selectedCount.ToString() + ")";
		}
		else if (req.action == "deselect")
		{
			if (req.name == "")
			{
				resp.status = "error";
				resp.message = "name parameter required for deselect action";
				return resp;
			}

			IEntitySource entSrc = FindEntityByName(api, req.name);
			if (!entSrc)
			{
				resp.status = "error";
				resp.message = "Entity not found: " + req.name;
				return resp;
			}

			api.RemoveFromEntitySelection(entSrc);
			resp.selectedCount = api.GetSelectedEntitiesCount();
			resp.status = "ok";
			resp.message = "Entity deselected: " + req.name;
		}
		else if (req.action == "clear")
		{
			api.ClearEntitySelection();
			resp.selectedCount = 0;
			resp.status = "ok";
			resp.message = "Selection cleared";
		}
		else if (req.action == "getSelected")
		{
			int selCount = api.GetSelectedEntitiesCount();
			resp.selectedCount = selCount;

			int maxReport = selCount;
			if (maxReport > 100)
				maxReport = 100; // Cap to prevent oversized responses

			for (int i = 0; i < maxReport; i++)
			{
				IEntitySource selSrc = api.GetSelectedEntity(i);
				if (selSrc)
				{
					resp.m_aSelectedNames.Insert(selSrc.GetName());
					resp.m_aSelectedClasses.Insert(selSrc.GetClassName());
				}
			}

			resp.status = "ok";
			resp.message = "Selected entities: " + selCount.ToString();
		}
		else
		{
			resp.status = "error";
			resp.message = "Unknown action: " + req.action + ". Valid: select, deselect, clear, getSelected";
		}

		return resp;
	}
}
