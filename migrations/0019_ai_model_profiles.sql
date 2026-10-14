CREATE TABLE ai_model_profiles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name TEXT NOT NULL,
  encrypted_api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  input_rate REAL CHECK(input_rate>=0),
  output_rate REAL CHECK(output_rate>=0),
  call_ceiling REAL NOT NULL DEFAULT 0 CHECK(call_ceiling>=0)
);
INSERT INTO ai_model_profiles(id,label,base_url,model_name,encrypted_api_key,enabled,input_rate,output_rate,call_ceiling)
  SELECT 'default',CASE WHEN TRIM(model_name)='' THEN '默认模型' ELSE model_name END,base_url,model_name,encrypted_api_key,enabled,input_rate,output_rate,call_ceiling FROM ai_model_configuration;
ALTER TABLE ai_model_configuration ADD COLUMN selected_model_id TEXT REFERENCES ai_model_profiles(id);
ALTER TABLE ai_model_configuration ADD COLUMN fallback_model_id TEXT REFERENCES ai_model_profiles(id);
UPDATE ai_model_configuration SET selected_model_id='default';
ALTER TABLE ai_model_config_events ADD COLUMN profiles_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_usage ADD COLUMN model_name TEXT;
ALTER TABLE ai_usage ADD COLUMN model_profile_id TEXT;
CREATE INDEX ai_insights_module_priority ON ai_insights(project_id,module,priority DESC,generated_at DESC,id);
CREATE INDEX ai_runs_module_finished ON ai_insight_runs(project_id,module,finished_at DESC);
ALTER TABLE ai_insight_runs ADD COLUMN selection_article_id INTEGER;
UPDATE ai_insight_runs SET selection_article_id=json_extract(input_json,'$.selection.article_id');
CREATE INDEX ai_runs_module_created ON ai_insight_runs(project_id,module,created_at DESC);
CREATE TABLE ai_runtime_configuration (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(version>0),
  external_enabled INTEGER NOT NULL CHECK(external_enabled IN (0,1)),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
