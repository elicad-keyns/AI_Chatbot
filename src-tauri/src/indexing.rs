use crate::agent::{RagContext, RagSettings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const INDEXER_SCRIPT: &str = include_str!("../../scripts/document_indexer.py");
const RETRIEVER_SCRIPT: &str = include_str!("../../scripts/retrieve_index.py");

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

fn temporary_retriever_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "chatbot-ai-document-retriever-{}.py",
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

pub async fn retrieve_rag_context(
    settings: &RagSettings,
    query: &str,
) -> Result<RagContext, String> {
    if !settings.enabled {
        return Err("RAG выключен".to_owned());
    }
    if settings.documents_path.trim().is_empty() {
        return Err("Для RAG сначала выберите и проиндексируйте папку документов".to_owned());
    }
    if query.trim().is_empty() {
        return Err("Невозможно выполнить RAG-поиск по пустому вопросу".to_owned());
    }
    if !matches!(settings.strategy.as_str(), "fixed" | "structural") {
        return Err("Стратегия RAG должна быть fixed или structural".to_owned());
    }

    let documents_root = {
        let path = PathBuf::from(&settings.documents_path);
        if path.is_absolute() {
            path
        } else {
            workspace_root().join(path)
        }
    };
    let output_root = {
        let path = PathBuf::from(&settings.output_path);
        if path.is_absolute() {
            path
        } else {
            documents_root.join(path)
        }
    };
    let index_path = output_root.join(&settings.strategy);
    if !index_path.join("index.faiss").is_file() || !index_path.join("metadata.json").is_file() {
        return Err(format!(
            "RAG-индекс не найден: {}. Сначала постройте индекс выбранной папки.",
            index_path.display()
        ));
    }

    let retriever_path = temporary_retriever_path();
    tokio::fs::write(&retriever_path, RETRIEVER_SCRIPT)
        .await
        .map_err(|error| format!("Не удалось подготовить RAG retriever: {error}"))?;
    let config_json = serde_json::to_vec(&serde_json::json!({
        "indexPath": index_path,
        "query": query,
        "topK": settings.top_k.clamp(1, 20),
        "minScore": settings.min_score.clamp(-1.0, 1.0),
    }))
    .map_err(|error| format!("Не удалось сериализовать RAG-настройки: {error}"))?;

    let indexing_config = DocumentIndexingConfig {
        enabled: true,
        debug: settings.debug,
        python_command: settings.python_command.clone(),
        documents_path: settings.documents_path.clone(),
        output_path: settings.output_path.clone(),
        fixed_chunk_size: 1200,
        fixed_chunk_overlap: 150,
        structural_chunk_size: 1600,
        model_name: String::new(),
        batch_size: 32,
    };
    let python_command = resolve_python_command(&indexing_config);
    let mut child = Command::new(&python_command)
        .arg(&retriever_path)
        .current_dir(workspace_root())
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!(
                "Не удалось запустить RAG retriever (`{}`): {error}",
                python_command.display()
            )
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&config_json)
            .await
            .map_err(|error| format!("Не удалось передать RAG-запрос: {error}"))?;
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "RAG-поиск превысил лимит 5 минут".to_owned())?
    .map_err(|error| format!("Ошибка RAG-процесса: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() {
        let structured_error = serde_json::from_str::<Value>(&stdout)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(structured_error
            .or_else(|| (!stderr.is_empty()).then_some(stderr))
            .unwrap_or_else(|| "RAG retriever завершился с ошибкой".to_owned()));
    }
    serde_json::from_str::<RagContext>(&stdout)
        .map_err(|error| format!("Некорректный ответ RAG retriever: {error}"))
}
