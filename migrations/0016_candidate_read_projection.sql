-- 目录投影的失效由数据库维护，HTTP、后台任务与 MCP 写入使用同一版本。
CREATE TABLE candidate_catalog_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  input_revision INTEGER NOT NULL DEFAULT 1,
  built_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO candidate_catalog_state(id) VALUES(1);

CREATE INDEX project_candidates_canonical ON project_candidates(
  (CASE WHEN substr(hostname,1,4)='www.' THEN substr(hostname,5) ELSE hostname END),
  (resolved_project_id IS NOT NULL) DESC,id
);
CREATE INDEX google_resource_domains_canonical ON google_resource_domains(
  (CASE WHEN substr(hostname,1,4)='www.' THEN substr(hostname,5) ELSE hostname END),resource_id
);
CREATE INDEX google_resources_picker ON google_resources(source,state,resource_key,account_id,id);

CREATE TRIGGER candidate_resources_insert AFTER INSERT ON google_resources BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_resources_delete AFTER DELETE ON google_resources BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_resources_update AFTER UPDATE OF account_id,source,resource_key,revision,state ON google_resources
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.source IS NOT NEW.source OR OLD.resource_key IS NOT NEW.resource_key
  OR OLD.revision IS NOT NEW.revision OR OLD.state IS NOT NEW.state BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_domains_insert AFTER INSERT ON google_resource_domains BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_domains_delete AFTER DELETE ON google_resource_domains BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_domains_update AFTER UPDATE OF resource_id,hostname ON google_resource_domains
WHEN OLD.resource_id IS NOT NEW.resource_id OR OLD.hostname IS NOT NEW.hostname BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_projects_insert AFTER INSERT ON projects BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_projects_delete AFTER DELETE ON projects BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_projects_update AFTER UPDATE OF website,account_id,gsc_account_id,ga4_account_id,gsc_site,ga4_property_id ON projects
WHEN OLD.website IS NOT NEW.website OR OLD.account_id IS NOT NEW.account_id OR OLD.gsc_account_id IS NOT NEW.gsc_account_id
  OR OLD.ga4_account_id IS NOT NEW.ga4_account_id OR OLD.gsc_site IS NOT NEW.gsc_site OR OLD.ga4_property_id IS NOT NEW.ga4_property_id BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_entries_insert AFTER INSERT ON project_candidates BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_entries_delete AFTER DELETE ON project_candidates BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
CREATE TRIGGER candidate_entries_hostname AFTER UPDATE OF hostname ON project_candidates WHEN OLD.hostname IS NOT NEW.hostname BEGIN
  UPDATE candidate_catalog_state SET input_revision=input_revision+1 WHERE id=1;
END;
