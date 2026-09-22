use super::*;

impl OpenCodeManager {
    /// Called before accepting requests. Runtime credentials and PIDs are never trusted after restart.
    pub async fn recover(&self) -> anyhow::Result<()> {
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM ai_sessions WHERE status IN ('ready','starting','stopping') OR pid IS NOT NULL")
            .fetch_all(&self.db).await?;
        for id in ids {
            sqlx::query("UPDATE ai_sessions SET status='sleeping', pid=NULL, error=NULL, updated_at=unixepoch() WHERE id=?")
                .bind(&id).execute(&self.db).await?;
            self.timeline(
                &id,
                "session.sleep",
                serde_json::json!({"reason":"backend_restart"}),
            )
            .await?;
        }
        Ok(())
    }

    pub(super) async fn timeline(
        &self,
        id: &str,
        action: &str,
        metadata: serde_json::Value,
    ) -> anyhow::Result<()> {
        audit::record(
            &self.db,
            NewAuditEvent {
                actor_user_id: None,
                actor_name: "Session Manager",
                origin: "opencode",
                action,
                target: id,
                command: None,
                result: if action == "error" {
                    "failure"
                } else {
                    "success"
                },
                duration_ms: 0,
                exit_code: None,
                ai_session_id: Some(id),
                ai_permission_mode: None,
                metadata,
            },
        )
        .await?;
        let _ = self.events.send(serde_json::json!({"type":"carobaguard.session.changed","properties":{"id":id,"action":action}}));
        Ok(())
    }

    pub(super) async fn sync_sessions(&self) -> anyhow::Result<()> {
        let mut state = self.inner.lock().await;
        refresh_child_status(&mut state);
        let id = state.session_id.clone();
        let phase = match state.phase {
            AgentPhase::Ready => "ready",
            AgentPhase::Starting => "starting",
            AgentPhase::Sleeping => "sleeping",
            AgentPhase::Error => "error",
        };
        let pid = state.child.as_ref().and_then(Child::id).map(i64::from);
        let error = state.error.clone();
        if !matches!(state.phase, AgentPhase::Ready | AgentPhase::Starting) {
            self.pending.lock().await.clear();
            self.approvals.lock().await.clear();
        }
        if let Some(id) = id {
            let previous: Option<String> =
                sqlx::query_scalar("SELECT status FROM ai_sessions WHERE id=?")
                    .bind(&id)
                    .fetch_optional(&self.db)
                    .await?;
            if previous
                .as_deref()
                .is_some_and(|s| !matches!(s, "archived" | "stopped"))
            {
                sqlx::query("UPDATE ai_sessions SET status=?, pid=?, error=?, updated_at=CASE WHEN status<>? THEN unixepoch() ELSE updated_at END WHERE id=?")
                    .bind(phase).bind(pid).bind(error).bind(phase).bind(&id).execute(&self.db).await?;
                drop(state);
                if previous.as_deref() != Some(phase) {
                    self.timeline(
                        &id,
                        match phase {
                            "ready" => "session.ready",
                            "sleeping" => "session.sleep",
                            "error" => "error",
                            _ => "session.started",
                        },
                        serde_json::json!({"state":phase}),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// Caller holds workspace_lock across selection and the operation using its connection.
    pub(super) async fn wake(&self, session: &AiSession) -> anyhow::Result<()> {
        anyhow::ensure!(session.status != "archived", "session is archived");
        let manager = self.clone();
        let id = session.id.clone();
        let project = PathBuf::from(session.project_path.as_deref().unwrap_or("."));
        let mode = AiPermissionMode::parse(&session.permission_mode);
        tokio::spawn(async move {
            let _transition = manager.transition_lock.lock().await;
            let result = async {
            let current: String = sqlx::query_scalar("SELECT status FROM ai_sessions WHERE id=?").bind(&id).fetch_one(&manager.db).await?;
            anyhow::ensure!(current != "archived", "session is archived");
            let runtime = manager.inner.lock().await;
            let same = runtime.session_id.as_deref() == Some(&id);
            let reusable = matches!(runtime.phase,AgentPhase::Ready) && runtime.mode==mode && runtime.project_path.as_deref()==Some(project.as_path());
            let old_id = runtime.session_id.clone();
            drop(runtime);
            if !same {
                if !reusable { manager.stop_inner().await; }
                else if let Some(old_id) = old_id {
                    sqlx::query("UPDATE ai_sessions SET status='sleeping',pid=NULL,updated_at=unixepoch() WHERE id=? AND status='ready'").bind(&old_id).execute(&manager.db).await?;
                    manager.timeline(&old_id,"session.sleep",serde_json::json!({"reason":"workspace_switch"})).await?;
                }
                manager.pending.lock().await.clear();
                manager.approvals.lock().await.clear();
            }
            manager.inner.lock().await.session_id = Some(id.clone());
            let previous: String = sqlx::query_scalar("SELECT status FROM ai_sessions WHERE id=?")
                .bind(&id)
                .fetch_one(&manager.db)
                .await?;
            if previous != "ready" {
                sqlx::query("UPDATE ai_sessions SET status='starting', error=NULL WHERE id=?")
                    .bind(&id)
                    .execute(&manager.db)
                    .await?;
                manager
                    .timeline(
                        &id,
                        if previous == "created" {
                            "session.started"
                        } else {
                            "session.resumed"
                        },
                        serde_json::json!({}),
                    )
                    .await?;
            }
            let result = manager.start_inner(&project, mode).await;
            if let Err(error) = &result {
                let mut runtime = manager.inner.lock().await;
                runtime.phase = AgentPhase::Error;
                runtime.error = Some(error.to_string());
            }
            manager.sync_sessions().await?;
            result?;
            let remote: Option<String> =
                sqlx::query_scalar("SELECT opencode_session_id FROM ai_sessions WHERE id=?")
                    .bind(&id)
                    .fetch_one(&manager.db)
                    .await?;
            if remote.is_none() {
                let title: String = sqlx::query_scalar("SELECT title FROM ai_sessions WHERE id=?")
                    .bind(&id)
                    .fetch_one(&manager.db)
                    .await?;
                let remote = manager
                    .request_json(
                        Method::POST,
                        "/session",
                        Some(serde_json::json!({"title":title})),
                    )
                    .await?;
                let remote_id = remote["id"]
                    .as_str()
                    .filter(|id| valid_remote_id(id, "ses"))
                    .ok_or_else(|| anyhow::anyhow!("invalid OpenCode session mapping"))?;
                sqlx::query("UPDATE ai_sessions SET opencode_session_id=? WHERE id=?")
                    .bind(remote_id)
                    .bind(&id)
                    .execute(&manager.db)
                    .await?;
            }
            let remote: String =
                sqlx::query_scalar("SELECT opencode_session_id FROM ai_sessions WHERE id=?")
                    .bind(&id)
                    .fetch_one(&manager.db)
                    .await?;
            let history = manager
                .request_json(Method::GET, &format!("/session/{remote}/message"), None)
                .await?;
            manager.cache_history(&id, &history).await?;
            sqlx::query("UPDATE ai_sessions SET last_active_at=unixepoch() WHERE id=?")
                .bind(&id)
                .execute(&manager.db)
                .await?;
            Ok::<_, anyhow::Error>(())
            }.await;
            if let Err(error) = &result {
                manager.stop_inner().await;
                let mut runtime = manager.inner.lock().await;
                runtime.session_id=Some(id.clone());
                runtime.phase=AgentPhase::Error;
                runtime.error=Some(error.to_string());
                drop(runtime);
                manager.sync_sessions().await?;
            }
            result
        })
        .await?
    }

    pub(super) async fn cache_history(
        &self,
        id: &str,
        value: &serde_json::Value,
    ) -> anyhow::Result<()> {
        if let Some(messages) = value.as_array() {
            let mut tx = self.db.begin().await?;
            for message in messages {
                if let Some(mid) = message["info"]["id"].as_str() {
                    let payload = serde_json::to_string(message)?;
                    anyhow::ensure!(
                        payload.len() <= MAX_OPENCODE_RESPONSE,
                        "message exceeds storage limit"
                    );
                    sqlx::query("INSERT INTO ai_messages(session_id,message_id,payload) VALUES(?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET payload=excluded.payload")
                        .bind(id).bind(mid).bind(payload).execute(&mut *tx).await?;
                }
            }
            tx.commit().await?;
        }
        Ok(())
    }

    pub(super) async fn observe_event(&self, event: &serde_json::Value) -> anyhow::Result<()> {
        let props = &event["properties"];
        let remote = props["sessionID"]
            .as_str()
            .or(props["part"]["sessionID"].as_str())
            .or(props["info"]["sessionID"].as_str());
        let Some(remote) = remote else { return Ok(()) };
        let local: Option<String> =
            sqlx::query_scalar("SELECT id FROM ai_sessions WHERE opencode_session_id=?")
                .bind(remote)
                .fetch_optional(&self.db)
                .await?;
        let Some(id) = local else { return Ok(()) };
        if self.inner.lock().await.session_id.as_deref() != Some(&id) {
            return Ok(());
        }
        sqlx::query("UPDATE ai_sessions SET last_active_at=unixepoch() WHERE id=?")
            .bind(&id)
            .execute(&self.db)
            .await?;
        let kind = event["type"].as_str().unwrap_or("");
        if matches!(kind, "message.updated" | "message.part.updated") {
            let mid = props["info"]["id"]
                .as_str()
                .or(props["part"]["messageID"].as_str());
            if let Some(mid) = mid {
                let stored: Option<String> = sqlx::query_scalar(
                    "SELECT payload FROM ai_messages WHERE session_id=? AND message_id=?",
                )
                .bind(&id)
                .bind(mid)
                .fetch_optional(&self.db)
                .await?;
                let mut message: serde_json::Value = stored
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| serde_json::json!({"info":{"id":mid},"parts":[]}));
                if kind == "message.updated" {
                    message["info"] = props["info"].clone();
                } else {
                    let part = &props["part"];
                    if let Some(parts) = message["parts"].as_array_mut() {
                        if let Some(existing) = parts.iter_mut().find(|p| p["id"] == part["id"]) {
                            *existing = part.clone();
                        } else {
                            parts.push(part.clone());
                        }
                    }
                }
                self.cache_history(&id, &serde_json::json!([message]))
                    .await?;
            }
        }
        match kind {
            "permission.asked" | "permission.v2.asked" => {
                let Some(request_id) = props["id"].as_str().filter(|id| valid_remote_id(id, "per"))
                else {
                    anyhow::bail!("invalid permission request")
                };
                let mut details = props.clone();
                details["local_session_id"] = id.clone().into();
                let state = self.inner.lock().await;
                details["directory"] = state
                    .project_path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .into();
                let mode = state.mode;
                drop(state);
                let key = approval_key(&details);
                self.timeline(&id,"permission.asked", serde_json::json!({"request_id":request_id,"action":props["permission"],"patterns":props["patterns"]})).await?;
                if mode == AiPermissionMode::ReadOnly
                    || self.approvals.lock().await.contains(&(id.clone(), key))
                {
                    let reply = if mode == AiPermissionMode::ReadOnly {
                        "reject"
                    } else {
                        "once"
                    };
                    self.request_json(
                        Method::POST,
                        &format!("/permission/{request_id}/reply"),
                        Some(serde_json::json!({"reply":reply})),
                    )
                    .await?;
                    self.timeline(
                        &id,
                        if reply == "reject" {
                            "permission.denied"
                        } else {
                            "permission.approved"
                        },
                        serde_json::json!({"request_id":request_id,"automatic":true}),
                    )
                    .await?;
                } else {
                    let mut pending = self.pending.lock().await;
                    anyhow::ensure!(pending.len() < 128, "too many pending permissions");
                    pending.insert(request_id.to_owned(), details);
                }
            }
            "permission.replied" | "permission.v2.replied" => {
                if let Some(id) = props["requestID"].as_str().or(props["id"].as_str()) {
                    self.pending.lock().await.remove(id);
                }
            }
            "message.part.updated" => {
                let part = &props["part"];
                if part["type"] == "tool" {
                    let status = part["state"]["status"].as_str().unwrap_or("");
                    let action = match status {
                        "running" => "command.started",
                        "completed" | "error" => "command.finished",
                        _ => return Ok(()),
                    };
                    let call = part["callID"].as_str().unwrap_or("");
                    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE ai_session_id=? AND action=? AND json_extract(metadata_json,'$.call_id')=?").bind(&id).bind(action).bind(call).fetch_one(&self.db).await?;
                    if exists == 0 {
                        self.timeline(
                            &id,
                            action,
                            serde_json::json!({"call_id":call,"tool":part["tool"],"status":status}),
                        )
                        .await?;
                        if status == "completed"
                            && matches!(
                                part["tool"].as_str(),
                                Some("edit" | "write" | "apply_patch")
                            )
                        {
                            self.timeline(&id,"file.modified",serde_json::json!({"call_id":call,"path":part["state"]["input"]["filePath"]})).await?;
                        }
                    }
                }
            }
            "session.error" => {
                self.timeline(&id, "error", serde_json::json!({"source":"opencode"}))
                    .await?;
            }
            _ => {}
        }
        Ok(())
    }
}

fn approval_key(details: &serde_json::Value) -> String {
    // Exact action/resources only: no model-supplied wildcard expands the grant.
    serde_json::json!([
        details["permission"],
        details["patterns"],
        details["resources"],
        details["metadata"]
    ])
    .to_string()
}

#[derive(Deserialize)]
pub struct SessionAction {
    action: String,
    title: Option<String>,
    confirmation: Option<String>,
}

pub async fn session_details(
    State(state): State<AppState>,
    user: AuthUser,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    user.role.require(Role::Operator)?;
    state
        .opencode
        .sync_sessions()
        .await
        .map_err(ApiError::internal)?;
    let mut session = ai_session(&state.db, &id).await?;
    let git =
        crate::projects::workspace_git(Path::new(session.project_path.as_deref().unwrap_or(".")))
            .await;
    sqlx::query("UPDATE ai_sessions SET branch=? WHERE id=?")
        .bind(git["branch"].as_str())
        .bind(&id)
        .execute(&state.db)
        .await?;
    session.branch = git["branch"].as_str().map(ToOwned::to_owned);
    let timeline = sqlx::query_as::<_, audit::AuditEvent>("SELECT * FROM audit_events WHERE ai_session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200").bind(&id).fetch_all(&state.db).await?;
    let pending: Vec<_> = state
        .opencode
        .pending
        .lock()
        .await
        .values()
        .filter(|p| p["local_session_id"] == id)
        .cloned()
        .collect();
    let payloads: Vec<String> = sqlx::query_scalar(
        "SELECT payload FROM ai_messages WHERE session_id=? ORDER BY message_id DESC LIMIT 30",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let mut output = String::new();
    for payload in payloads.iter().rev() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload)
            && let Some(parts) = value["parts"].as_array()
        {
            for part in parts {
                if part["type"] == "tool" && output.len() < 65536 {
                    output.extend(
                        part["state"]["output"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(65536 - output.len()),
                    );
                    output.push('\n');
                }
            }
        }
    }
    Ok(Json(
        serde_json::json!({"session":session,"git":git,"timeline":timeline,"pending_permissions":pending,"output":output}),
    ))
}

pub async fn session_action(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<SessionAction>,
) -> ApiResult<Json<AiSession>> {
    tokio::spawn(session_action_inner(state, user, headers, id, request))
        .await
        .map_err(ApiError::internal)?
}

async fn session_action_inner(
    state: AppState,
    user: AuthUser,
    headers: HeaderMap,
    id: String,
    request: SessionAction,
) -> ApiResult<Json<AiSession>> {
    user.role.require(Role::Operator)?;
    auth::verify_csrf(&user, &headers)?;
    // Lifecycle actions may interrupt a prompt; they serialize routing through start_lock.
    let session = ai_session(&state.db, &id).await?;
    if session.permission_mode == "unrestricted" {
        user.role.require(Role::Admin)?;
    }
    match request.action.as_str() {
        "start" | "resume" => {
            ensure_mode_authorized(
                &user,
                AiPermissionMode::parse(&session.permission_mode),
                request.confirmation.as_deref(),
            )?;
            let _workspace = state
                .opencode
                .workspace_lock
                .clone()
                .try_lock_owned()
                .map_err(|_| ApiError::service_unavailable("workspace is busy"))?;
            state
                .opencode
                .wake(&session)
                .await
                .map_err(ApiError::internal)?;
        }
        "rename" => {
            let title = request.title.as_deref().unwrap_or("").trim();
            if title.is_empty() || title.len() > 200 || title.chars().any(char::is_control) {
                return Err(ApiError::bad_request("invalid session name"));
            }
            sqlx::query("UPDATE ai_sessions SET title=?, updated_at=unixepoch() WHERE id=?")
                .bind(title)
                .bind(&id)
                .execute(&state.db)
                .await?;
            state
                .opencode
                .timeline(&id, "session.renamed", serde_json::json!({"actor":user.id}))
                .await
                .map_err(ApiError::internal)?;
        }
        "sleep" | "stop" | "archive" => {
            let manager = state.opencode.clone();
            let id = id.clone();
            let action = request.action.clone();
            tokio::spawn(async move {
                let _transition = manager.transition_lock.lock().await;
                let _lock = manager.start_lock.lock().await;
                sqlx::query("UPDATE ai_sessions SET status='stopping',updated_at=unixepoch() WHERE id=? AND status<>'archived'").bind(&id).execute(&manager.db).await?;
                let mut runtime = manager.inner.lock().await;
                let child = if runtime.session_id.as_deref()==Some(&id) { detach_child(&mut runtime) } else { None };
                drop(runtime);
                terminate_child(child).await;
                manager.pending.lock().await.retain(|_,p|p["local_session_id"]!=id);
                manager.approvals.lock().await.retain(|(sid,_)|sid!=&id);
                let status = match action.as_str() {"sleep"=>"sleeping","stop"=>"stopped",_=>"archived"};
                sqlx::query("UPDATE ai_sessions SET status=?, pid=NULL, error=NULL, updated_at=unixepoch() WHERE id=?").bind(status).bind(&id).execute(&manager.db).await?;
                manager.timeline(&id,match action.as_str(){"sleep"=>"session.sleep","stop"=>"session.stopped",_=>"session.archived"},serde_json::json!({})).await
            }).await.map_err(ApiError::internal)?.map_err(ApiError::internal)?;
        }
        _ => return Err(ApiError::bad_request("unknown session action")),
    }
    Ok(Json(ai_session(&state.db, &id).await?))
}

pub async fn delete_session(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    user.role.require(Role::Operator)?;
    auth::verify_csrf(&user, &headers)?;
    let _workspace = state
        .opencode
        .workspace_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| ApiError::service_unavailable("stop the active request before deletion"))?;
    let _transition = state.opencode.transition_lock.lock().await;
    let _lifecycle = state.opencode.start_lock.lock().await;
    let session = ai_session(&state.db, &id).await?;
    if session.permission_mode == "unrestricted" {
        user.role.require(Role::Admin)?;
    }
    let runtime = state.opencode.inner.lock().await;
    if runtime.session_id.as_deref() == Some(&id) && runtime.child.is_some() {
        return Err(ApiError::bad_request(
            "stop or sleep the session before deletion",
        ));
    }
    drop(runtime);
    state
        .opencode
        .timeline(&id, "session.deleted", serde_json::json!({"actor":user.id}))
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM ai_sessions WHERE id=?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .opencode
        .pending
        .lock()
        .await
        .retain(|_, p| p["local_session_id"] != id);
    state
        .opencode
        .approvals
        .lock()
        .await
        .retain(|(sid, _)| sid != &id);
    Ok(Json(
        serde_json::json!({"ok":true,"native_history_retained":true}),
    ))
}

pub(super) async fn permission_decision(
    manager: &OpenCodeManager,
    session: &AiSession,
    request_id: &str,
    request: &PermissionReplyRequest,
) -> ApiResult<serde_json::Value> {
    let _lifecycle = manager.start_lock.lock().await;
    let details = manager
        .pending
        .lock()
        .await
        .get(request_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("permission is no longer pending"))?;
    if details["local_session_id"] != session.id
        || details["sessionID"] != session.opencode_session_id.as_deref().unwrap_or("")
        || manager.inner.lock().await.session_id.as_deref() != Some(&session.id)
    {
        return Err(ApiError::forbidden("permission belongs to another session"));
    }
    if session.permission_mode != "approval" && !matches!(request.reply, PermissionReply::Reject) {
        return Err(ApiError::forbidden("this session cannot approve actions"));
    }
    if request.message.as_ref().is_some_and(|m| m.len() > 4096) {
        return Err(ApiError::bad_request("permission context is too long"));
    }
    // Never send `always` upstream: newer OpenCode versions can persist saved rules.
    let reply = if matches!(request.reply, PermissionReply::Reject) {
        "reject"
    } else {
        "once"
    };
    manager
        .timeline(
            &session.id,
            if reply == "reject" {
                "permission.denied"
            } else {
                "permission.approved"
            },
            serde_json::json!({"request_id":request_id,"scope":request.reply.as_str()}),
        )
        .await
        .map_err(ApiError::internal)?;
    let response = manager
        .request_json(
            Method::POST,
            &format!("/permission/{request_id}/reply"),
            Some(serde_json::json!({"reply":reply,"message":request.message})),
        )
        .await
        .map_err(ApiError::internal)?;
    if matches!(request.reply, PermissionReply::Always) {
        manager
            .approvals
            .lock()
            .await
            .insert((session.id.clone(), approval_key(&details)));
    }
    manager.pending.lock().await.remove(request_id);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config, docker::DockerService, logs::LogService, services::SystemdService,
        telemetry::TelemetryService, terminal::TerminalService,
    };

    async fn fixture() -> (tempfile::TempDir, AppState, AuthUser, HeaderMap) {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let config = Arc::new(Config::test(temp.path().to_path_buf()));
        let pool = db::connect(&config).await.unwrap();
        let user = AuthUser {
            id: Uuid::new_v4().to_string(),
            username: "test".into(),
            role: Role::Admin,
            session_id: "login".into(),
            csrf_token: "csrf".into(),
        };
        sqlx::query("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES(?,?,'unused','admin',0,0)").bind(&user.id).bind(&user.username).execute(&pool).await.unwrap();
        let binary = temp.path().join("fake-opencode");
        std::fs::write(
            &binary,
            include_str!("../../tests/fixtures/fake_opencode.py"),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut manager = OpenCodeManager::new(pool.clone());
        manager.binary = binary.display().to_string();
        manager.recover().await.unwrap();
        let telemetry = TelemetryService::start(pool.clone()).await.unwrap();
        let state = AppState {
            config,
            db: pool,
            opencode: manager,
            telemetry,
            docker: DockerService::default(),
            systemd: SystemdService::default(),
            terminal: TerminalService::new(2),
            logs: LogService::new(2),
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-csrf-token", "csrf".parse().unwrap());
        (temp, state, user, headers)
    }

    async fn create(
        state: &AppState,
        user: &AuthUser,
        headers: &HeaderMap,
        mode: AiPermissionMode,
    ) -> AiSession {
        let (_, Json(session)) = create_session(
            State(state.clone()),
            user.clone(),
            headers.clone(),
            Json(CreateSessionRequest {
                title: Some("Persistent workspace".into()),
                project_path: Some(state.config.data_dir.display().to_string()),
                permission_mode: Some(mode),
                confirmation: None,
            }),
        )
        .await
        .unwrap();
        session
    }

    async fn action(
        state: &AppState,
        user: &AuthUser,
        headers: &HeaderMap,
        id: &str,
        action: &str,
    ) -> ApiResult<Json<AiSession>> {
        session_action(
            State(state.clone()),
            user.clone(),
            headers.clone(),
            AxumPath(id.into()),
            Json(SessionAction {
                action: action.into(),
                title: None,
                confirmation: None,
            }),
        )
        .await
    }

    #[tokio::test]
    async fn create_persist_reload_sleep_resume_and_backend_restart_preserve_context() {
        let (_temp, state, user, headers) = fixture().await;
        let session = create(&state, &user, &headers, AiPermissionMode::ReadOnly).await;
        assert_eq!(session.status, "created");
        assert!(state.opencode.inner.lock().await.child.is_none());
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        let pid = state.opencode.status().await.pid.unwrap();
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        assert_eq!(state.opencode.status().await.pid, Some(pid));
        let context = state
            .opencode
            .request_json(Method::GET, "/test/context", None)
            .await
            .unwrap();
        assert_eq!(context["cwd"], session.project_path.as_deref().unwrap());
        assert_eq!(
            context["query"]["directory"][0],
            session.project_path.as_deref().unwrap()
        );
        let _ = chat(
            State(state.clone()),
            user.clone(),
            headers.clone(),
            AxumPath(session.id.clone()),
            Json(ChatRequest {
                message: "Remember workspace".into(),
                context: None,
            }),
        )
        .await
        .unwrap();
        let _ = action(&state, &user, &headers, &session.id, "sleep")
            .await
            .unwrap();
        assert_eq!(
            ai_session(&state.db, &session.id).await.unwrap().status,
            "sleeping"
        );
        let Json(history) = messages(
            State(state.clone()),
            user.clone(),
            AxumPath(session.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].text, "Remember workspace");
        assert!(state.opencode.status().await.pid.is_none());
        let mut restarted = OpenCodeManager::new(state.db.clone());
        restarted.binary = state.opencode.binary.clone();
        sqlx::query("UPDATE ai_sessions SET status='starting',pid=999999 WHERE id=?")
            .bind(&session.id)
            .execute(&state.db)
            .await
            .unwrap();
        restarted.recover().await.unwrap();
        let restored = ai_session(&state.db, &session.id).await.unwrap();
        assert_eq!(restored.project_path, session.project_path);
        assert_eq!(restored.status, "sleeping");
        assert!(
            restored
                .opencode_session_id
                .as_deref()
                .unwrap()
                .starts_with("ses_")
        );
        restarted.wake(&restored).await.unwrap();
        assert!(restarted.status().await.pid.is_some());
        restarted.stop().await;
    }

    #[tokio::test]
    async fn concurrent_start_uses_one_child_and_dead_process_recovers() {
        let (_temp, state, user, headers) = fixture().await;
        let session = create(&state, &user, &headers, AiPermissionMode::ReadOnly).await;
        let (a, b) = tokio::join!(
            state
                .opencode
                .start(state.config.data_dir.as_path(), AiPermissionMode::ReadOnly),
            state
                .opencode
                .start(state.config.data_dir.as_path(), AiPermissionMode::ReadOnly)
        );
        assert_eq!(a.unwrap().pid, b.unwrap().pid);
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        state
            .opencode
            .inner
            .lock()
            .await
            .child
            .as_mut()
            .unwrap()
            .kill()
            .await
            .unwrap();
        state.opencode.sync_sessions().await.unwrap();
        assert_eq!(
            ai_session(&state.db, &session.id).await.unwrap().status,
            "error"
        );
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        assert_eq!(
            ai_session(&state.db, &session.id).await.unwrap().status,
            "ready"
        );
        state.opencode.stop().await;
    }

    #[tokio::test]
    async fn cancelled_start_finishes_and_stream_receiver_cleanup_is_bounded() {
        let (_temp, state, _user, _headers) = fixture().await;
        let manager = state.opencode.clone();
        let path = state.config.data_dir.clone();
        let task =
            tokio::spawn(async move { manager.start(&path, AiPermissionMode::ReadOnly).await });
        tokio::time::sleep(Duration::from_millis(40)).await;
        task.abort();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(state.opencode.status().await.phase, AgentPhase::Ready) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let receiver = state.opencode.subscribe();
        assert_eq!(state.opencode.events.receiver_count(), 1);
        drop(receiver);
        assert_eq!(state.opencode.events.receiver_count(), 0);
        let event_task = state
            .opencode
            .inner
            .lock()
            .await
            .event_task
            .clone()
            .unwrap();
        state.opencode.stop().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(event_task.is_finished());
        assert!(state.opencode.status().await.pid.is_none());
    }

    fn permission(session: &AiSession, id: &str) -> serde_json::Value {
        serde_json::json!({"type":"permission.asked","properties":{"id":id,"sessionID":session.opencode_session_id,"permission":"bash","patterns":["touch file"],"metadata":{"command":"touch file"}}})
    }

    async fn decide(
        manager: &OpenCodeManager,
        session: &AiSession,
        id: &str,
        reply: PermissionReply,
    ) -> ApiResult<serde_json::Value> {
        permission_decision(
            manager,
            session,
            id,
            &PermissionReplyRequest {
                reply,
                message: None,
                session_id: session.id.clone(),
            },
        )
        .await
    }

    #[tokio::test]
    async fn approval_once_session_deny_and_cross_session_isolation() {
        let (_temp, state, user, headers) = fixture().await;
        let session = create(&state, &user, &headers, AiPermissionMode::Approval).await;
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        let session = ai_session(&state.db, &session.id).await.unwrap();
        state
            .opencode
            .observe_event(&permission(&session, "per_once"))
            .await
            .unwrap();
        let other = create(&state, &user, &headers, AiPermissionMode::Approval).await;
        assert!(
            decide(&state.opencode, &other, "per_once", PermissionReply::Once)
                .await
                .is_err()
        );
        decide(&state.opencode, &session, "per_once", PermissionReply::Once)
            .await
            .unwrap();
        assert!(state.opencode.approvals.lock().await.is_empty());
        state
            .opencode
            .observe_event(&permission(&session, "per_session"))
            .await
            .unwrap();
        decide(
            &state.opencode,
            &session,
            "per_session",
            PermissionReply::Always,
        )
        .await
        .unwrap();
        state
            .opencode
            .observe_event(&permission(&session, "per_auto"))
            .await
            .unwrap();
        assert!(!state.opencode.pending.lock().await.contains_key("per_auto"));
        let replies = std::fs::read_to_string(state.config.data_dir.join(".fake-replies")).unwrap();
        assert!(!replies.contains("always"));
        assert_eq!(replies.lines().count(), 3);
        let _ = action(&state, &user, &headers, &session.id, "sleep")
            .await
            .unwrap();
        assert!(state.opencode.approvals.lock().await.is_empty());
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        state
            .opencode
            .observe_event(&permission(&session, "per_deny"))
            .await
            .unwrap();
        decide(
            &state.opencode,
            &session,
            "per_deny",
            PermissionReply::Reject,
        )
        .await
        .unwrap();
        assert!(state.opencode.pending.lock().await.is_empty());
        assert!(
            std::fs::read_to_string(state.config.data_dir.join(".fake-replies"))
                .unwrap()
                .contains("reject")
        );
        assert_eq!(
            db::setting(&state.db, "ai_global_permission_mode")
                .await
                .unwrap()
                .as_deref(),
            Some("read_only")
        );
        state.opencode.stop().await;
    }

    #[tokio::test]
    async fn read_only_blocks_mutation_and_cannot_be_approved() {
        let (_temp, state, user, headers) = fixture().await;
        let session = create(&state, &user, &headers, AiPermissionMode::ReadOnly).await;
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        let session = ai_session(&state.db, &session.id).await.unwrap();
        assert!(
            state
                .opencode
                .request_json(Method::POST, "/test/mutate", None)
                .await
                .is_err()
        );
        let mut details = permission(&session, "per_readonly")["properties"].clone();
        details["local_session_id"] = session.id.clone().into();
        state
            .opencode
            .pending
            .lock()
            .await
            .insert("per_readonly".into(), details);
        assert!(
            decide(
                &state.opencode,
                &session,
                "per_readonly",
                PermissionReply::Once
            )
            .await
            .is_err()
        );
        state
            .opencode
            .observe_event(&permission(&session, "per_block"))
            .await
            .unwrap();
        assert!(
            std::fs::read_to_string(state.config.data_dir.join(".fake-replies"))
                .unwrap()
                .contains("reject")
        );
        state.opencode.stop().await;
    }

    #[tokio::test]
    async fn archive_and_delete_require_safe_state_and_preserve_workspace() {
        let (_temp, state, user, headers) = fixture().await;
        let session = create(&state, &user, &headers, AiPermissionMode::ReadOnly).await;
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        assert!(
            delete_session(
                State(state.clone()),
                user.clone(),
                headers.clone(),
                AxumPath(session.id.clone())
            )
            .await
            .is_err()
        );
        let _ = action(&state, &user, &headers, &session.id, "archive")
            .await
            .unwrap();
        assert!(
            action(&state, &user, &headers, &session.id, "resume")
                .await
                .is_err()
        );
        let _ = delete_session(
            State(state.clone()),
            user.clone(),
            headers.clone(),
            AxumPath(session.id.clone()),
        )
        .await
        .unwrap();
        assert!(ai_session(&state.db, &session.id).await.is_err());
        assert!(state.config.data_dir.is_dir());
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE ai_session_id=? AND action='session.deleted'",
        )
        .bind(&session.id)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }
    #[tokio::test]
    async fn router_auth_csrf_and_sse_disconnect() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let (_temp, state, user, _headers) = fixture().await;
        let token = "fixture-token";
        let hash = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(token.as_bytes()));
        sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,created_at,expires_at,last_seen_at) VALUES('login',?,?, 'csrf',unixepoch(),unixepoch()+3600,unixepoch())").bind(&user.id).bind(hash).execute(&state.db).await.unwrap();
        let router = crate::api::router(state.clone());
        let no_auth = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/opencode/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        let no_csrf = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/opencode/sessions")
                    .header("cookie", "carobaguard_session=fixture-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/opencode/events")
                    .header("cookie", "carobaguard_session=fixture-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(state.opencode.events.receiver_count(), 1);
        drop(response);
        assert_eq!(state.opencode.events.receiver_count(), 0);
        state.opencode.shutdown().await;
    }

    #[tokio::test]
    async fn workspace_switch_reuses_compatible_process_without_grants() {
        let (_temp, state, user, headers) = fixture().await;
        let first = create(&state, &user, &headers, AiPermissionMode::Approval).await;
        let _ = action(&state, &user, &headers, &first.id, "resume")
            .await
            .unwrap();
        let pid = state.opencode.status().await.pid;
        state
            .opencode
            .approvals
            .lock()
            .await
            .insert((first.id.clone(), "old grant".into()));
        let second = create(&state, &user, &headers, AiPermissionMode::Approval).await;
        let _ = action(&state, &user, &headers, &second.id, "resume")
            .await
            .unwrap();
        assert_eq!(pid, state.opencode.status().await.pid);
        assert!(state.opencode.approvals.lock().await.is_empty());
        assert_eq!(
            ai_session(&state.db, &first.id).await.unwrap().status,
            "sleeping"
        );
        assert_eq!(
            ai_session(&state.db, &second.id).await.unwrap().status,
            "ready"
        );
        state.opencode.shutdown().await;
    }

    #[tokio::test]
    async fn startup_failure_is_recoverable_and_keeps_metadata() {
        let (_temp, mut state, user, headers) = fixture().await;
        let session = create(&state, &user, &headers, AiPermissionMode::ReadOnly).await;
        let binary = state.opencode.binary.clone();
        state.opencode.binary = "/nonexistent/carobaguard-opencode".into();
        assert!(
            action(&state, &user, &headers, &session.id, "resume")
                .await
                .is_err()
        );
        let failed = ai_session(&state.db, &session.id).await.unwrap();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.title, session.title);
        assert!(failed.pid.is_none());
        state.opencode.binary = binary;
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        state.opencode.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "requires CAROBAGUARD_TEST_OPENCODE pointing to a real OpenCode executable"]
    async fn real_opencode_mapping_survives_sleep_without_provider_calls() {
        let (_temp, mut state, user, headers) = fixture().await;
        state.opencode.binary =
            std::env::var("CAROBAGUARD_TEST_OPENCODE").expect("explicit test executable");
        let session = create(&state, &user, &headers, AiPermissionMode::ReadOnly).await;
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        let before = ai_session(&state.db, &session.id).await.unwrap();
        assert!(before.opencode_session_id.is_some());
        let _ = action(&state, &user, &headers, &session.id, "sleep")
            .await
            .unwrap();
        let _ = action(&state, &user, &headers, &session.id, "resume")
            .await
            .unwrap();
        assert_eq!(
            ai_session(&state.db, &session.id)
                .await
                .unwrap()
                .opencode_session_id,
            before.opencode_session_id
        );
        // Delete only the native session created by this test.
        state
            .opencode
            .request_json(
                Method::DELETE,
                &format!("/session/{}", before.opencode_session_id.unwrap()),
                None,
            )
            .await
            .unwrap();
        state.opencode.shutdown().await;
    }
}
