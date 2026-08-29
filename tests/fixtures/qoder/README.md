# Qoder fixtures

由 `build-fixture.mjs` 从真实 Qoder 安装脱敏生成，镜像真实目录布局：

```
home/
  .qoder-cn/projects/<slug>/<session-id>.jsonl   # CN 转录
  .qoder-cn/projects/<slug>/<session-id>/subagents/  # 子代理清单 + 转录
  .qoder/projects/...                            # 国际版
  AppData/Roaming/com.qoder[cn].app.stable/main.sqlite  # GUI 元数据库
```

## ⚠️ 一次性迁移 SQL —— 不要重跑

2026-08-30 拆分 qoder / qoder-cn 时对 `~/.obelisk/obelisk.sqlite` 执行过以下清理
（删除混合 source 的旧行与旧游标，随后全量重建）：

```sql
DELETE FROM messages WHERE source='qoder';
DELETE FROM tool_calls    WHERE session_id IN (SELECT id FROM sessions WHERE source='qoder');
DELETE FROM tool_results  WHERE session_id IN (SELECT id FROM sessions WHERE source='qoder');
DELETE FROM subagents     WHERE session_id IN (SELECT id FROM sessions WHERE source='qoder');
DELETE FROM sessions      WHERE source='qoder';
DELETE FROM index_state   WHERE jsonl_path LIKE '%\.qoder-cn%' OR jsonl_path LIKE '%\.qoder%';
```

**警告：现在重跑会把 `source='qoder'`（国际版）的会话删掉**（重建可恢复，但没必要）。
该脚本仅在"混合数据 + 双 provider 并存"的迁移窗口有意义，拆分完成后永久失效。
