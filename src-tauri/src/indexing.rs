use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const INDEXER_SCRIPT: &str = include_str!("../../scripts/document_indexer.py");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexingConfig {
    pub enabled: bool,
    pub debug: bool,
    pub python_command: String,
    pub documents_path: String,
    pub output_path: String,
    pub fixed_chunk_size: usize,
    pub fixed_chunk_overlap: usize,
    pub structural_chunk_size: usize,
    pub model_name: String,
    pub batch_size: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexingLogEvent {
    pub stream: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexingResult {
    pub success: bool,
    pub summary: Value,
}

fn temporary_script_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "chatbot-ai-document-indexer-{}.py",
        env!("CARGO_PKG_VERSION")
    ))
}

fn workspace_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(parent) = manifest_dir.parent() {
        if parent.join("package.json").is_file() {
            return parent.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or(manifest_dir)
}

fn resolve_python_command(config: &DocumentIndexingConfig) -> PathBuf {
    let configured = config.python_command.trim();
    let mut roots = Vec::new();
    let documents_root = PathBuf::from(&config.documents_path);
    if documents_root.is_absolute() {
        roots.push(documents_root);
    } else if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir.join(&documents_root));
        roots.push(current_dir.clone());
        if let Some(parent) = current_dir.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots.push(workspace_root());

    let configured_path = PathBuf::from(configured);
    if configured_path.is_absolute() && configured_path.is_file() {
        return configured_path;
    }
    if !configured_path.is_absolute() && configured_path.components().count() > 1 {
        if let Some(candidate) = roots
            .iter()
            .map(|root| root.join(&configured_path))
            .find(|path| path.is_file())
        {
            return candidate;
        }
    }

    if configured.eq_ignore_ascii_case("python") || configured.eq_ignore_ascii_case("python.exe") {
        let relative_venv_python = if cfg!(windows) {
            PathBuf::from(".venv").join("Scripts").join("python.exe")
        } else {
            PathBuf::from(".venv").join("bin").join("python")
        };
        if let Some(candidate) = roots
            .iter()
            .map(|root| root.join(&relative_venv_python))
            .find(|path| path.is_file())
        {
            return candidate;
        }
    }
    PathBuf::from(configured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_workspace_virtual_environment_for_legacy_python_setting() {
        let config = DocumentIndexingConfig {
            enabled: true,
            debug: false,
            python_command: "python".to_string(),
            documents_path: ".".to_string(),
            output_path: "document-index".to_string(),
            fixed_chunk_size: 1200,
            fixed_chunk_overlap: 150,
            structural_chunk_size: 1600,
            model_name: "test".to_string(),
            batch_size: 32,
        };

        let resolved = resolve_python_command(&config);
        assert!(
            resolved.is_file(),
            "Python path does not exist: {resolved:?}"
        );
        assert!(resolved.to_string_lossy().contains(".venv"));
    }

    #[test]
    fn resolves_workspace_root_above_tauri_crate() {
        let root = workspace_root();
        assert!(root.join("package.json").is_file());
        assert!(root.join("src-tauri").join("Cargo.toml").is_file());
    }
}

pub async fn run_document_indexing(
    app_handle: AppHandle,
    config: DocumentIndexingConfig,
) -> Result<DocumentIndexingResult, String> {
    if !config.enabled {
        return Err("Индексация документов выключена в настройках".to_string());
    }
    if config.python_command.trim().is_empty() {
        return Err("Не указана команда Python".to_string());
    }
    if config.documents_path.trim().is_empty() {
        return Err("Сначала выберите папку с документами".to_string());
    }

    let script_path = temporary_script_path();
    tokio::fs::write(&script_path, INDEXER_SCRIPT)
        .await
        .map_err(|error| format!("Не удалось подготовить скрипт индексации: {error}"))?;

    let config_json = serde_json::to_vec(&config)
        .map_err(|error| format!("Не удалось сериализовать настройки: {error}"))?;
    let python_command = resolve_python_command(&config);
    let mut child = Command::new(&python_command)
        .arg(&script_path)
        .current_dir(workspace_root())
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!(
                "Не удалось запустить Python (`{}`): {error}. Установите Python 3.10+ или укажите полный путь в настройках.",
                python_command.display()
            )
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&config_json)
            .await
            .map_err(|error| format!("Не удалось передать настройки индексатору: {error}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or("Не удалось прочитать stdout индексатора")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Не удалось прочитать stderr индексатора")?;
    let stderr_app = app_handle.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let payload = serde_json::json!({"type": "stderr", "message": line});
            let _ = stderr_app.emit(
                "document_indexing_log",
                IndexingLogEvent {
                    stream: "stderr".to_string(),
                    payload,
                },
            );
            collected.push(line);
        }
        collected
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut final_summary = Value::Null;
    let mut final_error: Option<String> = None;
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| format!("Ошибка чтения журнала индексатора: {error}"))?
    {
        let payload = serde_json::from_str::<Value>(&line)
            .unwrap_or_else(|_| serde_json::json!({"type": "stdout", "message": line}));
        if payload.get("type").and_then(Value::as_str) == Some("result") {
            final_summary = payload.clone();
        }
        if payload.get("type").and_then(Value::as_str) == Some("error") {
            final_error = payload
                .get("message")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        let _ = app_handle.emit(
            "document_indexing_log",
            IndexingLogEvent {
                stream: "stdout".to_string(),
                payload,
            },
        );
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("Не удалось дождаться индексатора: {error}"))?;
    let stderr_lines = stderr_task.await.unwrap_or_default();
    if !status.success() {
        let detail = final_error
            .or_else(|| stderr_lines.last().cloned())
            .unwrap_or_else(|| "Подробности доступны в debug-журнале индексации".to_string());
        return Err(format!("Индексация завершилась с ошибкой: {detail}"));
    }

    Ok(DocumentIndexingResult {
        success: true,
        summary: final_summary,
    })
}
