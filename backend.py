# -*- coding: utf-8 -*-
"""本地数据、训练配置和灵敏度推荐逻辑。

本模块不访问 PUBG 进程，也不改写游戏配置。
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import time
import webview
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any


DATA_DIR = Path.home() / "PUBGSensitivityLab"
DB_FILE = DATA_DIR / "sensitivity_lab.db"
EXPORT_DIR = DATA_DIR / "exports"


DEFAULT_SETTINGS = {
    "mouse_model": "EDIFIER HECATE G5M Pro",
    "dpi": 1200,
    "polling_rate": 1000,
    "windows_pointer_speed": 6,
    "windows_acceleration": False,
    "resolution": "1920×1080",
    "refresh_rate": 144,
    "aspect_ratio": "16:9",
    "general": 40,
    "vertical_multiplier": 2.0,
    "aim": 44,
    "ads": 46,
    "scopes": {"red_dot": 44, "2x": 38, "3x": 40, "4x": 37, "6x": 35, "8x": 32, "15x": 26},
}


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def as_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def from_json(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, ValueError):
        return fallback


class ConnectionContext:
    """让 sqlite 的事务上下文在提交后也显式释放 Windows 文件句柄。"""

    def __init__(self, path: Path):
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row

    def __enter__(self) -> sqlite3.Connection:
        return self.connection

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            if exc_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
        finally:
            self.connection.close()


class Backend:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = Path(data_dir or DATA_DIR)
        self.db_file = self.data_dir / "sensitivity_lab.db"
        self.export_dir = self.data_dir / "exports"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._seed_default_profile()

    def _connect(self) -> sqlite3.Connection:
        return ConnectionContext(self.db_file)  # type: ignore[return-value]

    @staticmethod
    def _number(value: Any, fallback: float, low: float, high: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = fallback
        return max(low, min(high, parsed))

    @classmethod
    def _normalise_profile_payload(cls, profile: dict[str, Any]) -> dict[str, Any]:
        defaults = deepcopy(DEFAULT_SETTINGS)
        scopes = {**defaults["scopes"], **(profile.get("scopes") or {})}
        return {
            "mouse_model": str(profile.get("mouse_model") or defaults["mouse_model"]).strip()[:120],
            "dpi": int(cls._number(profile.get("dpi"), defaults["dpi"], 100, 26000)),
            "polling_rate": int(cls._number(profile.get("polling_rate"), defaults["polling_rate"], 125, 8000)),
            "windows_pointer_speed": int(cls._number(profile.get("windows_pointer_speed"), defaults["windows_pointer_speed"], 1, 11)),
            "windows_acceleration": bool(profile.get("windows_acceleration", defaults["windows_acceleration"])),
            "resolution": str(profile.get("resolution") or defaults["resolution"]).strip()[:40],
            "refresh_rate": int(cls._number(profile.get("refresh_rate"), defaults["refresh_rate"], 30, 1000)),
            "aspect_ratio": str(profile.get("aspect_ratio") or defaults["aspect_ratio"]).strip()[:20],
            "general": cls._number(profile.get("general"), defaults["general"], 1, 100),
            "vertical_multiplier": cls._number(profile.get("vertical_multiplier"), defaults["vertical_multiplier"], 0.5, 2.0),
            "aim": cls._number(profile.get("aim"), defaults["aim"], 1, 100),
            "ads": cls._number(profile.get("ads"), defaults["ads"], 1, 100),
            "scopes": {key: cls._number(scopes.get(key), fallback, 1, 100) for key, fallback in defaults["scopes"].items()},
        }

    @staticmethod
    def _profile_exists(conn: sqlite3.Connection, profile_id: int) -> bool:
        return conn.execute("SELECT 1 FROM profiles WHERE id=?", (profile_id,)).fetchone() is not None

    @staticmethod
    def _session_exists(conn: sqlite3.Connection, session_id: int) -> bool:
        return conn.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone() is not None

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS calibrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS trials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    trial_number INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recommendations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )

    def _seed_default_profile(self) -> None:
        with self._connect() as conn:
            if conn.execute("SELECT 1 FROM profiles LIMIT 1").fetchone():
                return
            timestamp = now()
            conn.execute(
                "INSERT INTO profiles(name, payload, created_at, updated_at) VALUES(?,?,?,?)",
                ("当前方案 · 1200 DPI", as_json(DEFAULT_SETTINGS), timestamp, timestamp),
            )

    @staticmethod
    def _profile(row: sqlite3.Row) -> dict[str, Any]:
        payload = from_json(row["payload"], {})
        return {"id": row["id"], "name": row["name"], **payload, "created_at": row["created_at"], "updated_at": row["updated_at"]}

    @staticmethod
    def _session(row: sqlite3.Row) -> dict[str, Any]:
        payload = from_json(row["payload"], {})
        return {"id": row["id"], "profile_id": row["profile_id"], "title": row["title"], **payload, "created_at": row["created_at"], "updated_at": row["updated_at"]}

    @staticmethod
    def _trial(row: sqlite3.Row) -> dict[str, Any]:
        payload = from_json(row["payload"], {})
        return {"id": row["id"], "session_id": row["session_id"], "trial_number": row["trial_number"], **payload, "created_at": row["created_at"]}

    def load_profiles(self) -> dict[str, Any]:
        with self._connect() as conn:
            profiles = [self._profile(row) for row in conn.execute("SELECT * FROM profiles ORDER BY id")]
            session_rows = conn.execute(
                "SELECT s.*, COUNT(t.id) AS trial_count FROM sessions s "
                "LEFT JOIN trials t ON t.session_id=s.id GROUP BY s.id ORDER BY s.updated_at DESC"
            )
            sessions = []
            for row in session_rows:
                session = self._session(row)
                session["trial_count"] = int(row["trial_count"] or 0)
                rec = conn.execute(
                    "SELECT payload FROM recommendations WHERE session_id=? ORDER BY id DESC LIMIT 1",
                    (row["id"],),
                ).fetchone()
                session["recommendation"] = from_json(rec["payload"], None) if rec else None
                sessions.append(session)
            calibrations = {}
            for row in conn.execute("SELECT * FROM calibrations ORDER BY id DESC"):
                key = str(row["profile_id"])
                if key not in calibrations:
                    calibrations[key] = {"id": row["id"], "profile_id": row["profile_id"], **from_json(row["payload"], {}), "created_at": row["created_at"]}
        return {"profiles": profiles, "sessions": sessions, "calibrations": calibrations}

    def save_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        profile_id = profile.get("id")
        name = str(profile.get("name") or "未命名方案").strip()[:80]
        payload = self._normalise_profile_payload(profile)
        timestamp = now()
        with self._connect() as conn:
            if profile_id:
                if not self._profile_exists(conn, int(profile_id)):
                    raise ValueError("找不到要更新的参数方案")
                conn.execute("UPDATE profiles SET name=?, payload=?, updated_at=? WHERE id=?", (name, as_json(payload), timestamp, int(profile_id)))
                row = conn.execute("SELECT * FROM profiles WHERE id=?", (int(profile_id),)).fetchone()
            else:
                cursor = conn.execute("INSERT INTO profiles(name, payload, created_at, updated_at) VALUES(?,?,?,?)", (name, as_json(payload), timestamp, timestamp))
                row = conn.execute("SELECT * FROM profiles WHERE id=?", (cursor.lastrowid,)).fetchone()
        return self._profile(row)

    def save_calibration(self, calibration: dict[str, Any]) -> dict[str, Any]:
        profile_id = int(calibration.get("profile_id") or 0)
        payload = {
            "distance_cm": self._number(calibration.get("distance_cm"), 20, 0.1, 500),
            "degrees": self._number(calibration.get("degrees"), 180, 1, 3600),
            "repeats": int(self._number(calibration.get("repeats"), 3, 1, 10)),
            "factor": self._number(calibration.get("factor"), 1, 0.5, 1.5),
            "confidence": str(calibration.get("confidence") or "中")[:10],
        }
        with self._connect() as conn:
            if not self._profile_exists(conn, profile_id):
                raise ValueError("校准对应的参数方案不存在")
            cursor = conn.execute("INSERT INTO calibrations(profile_id, payload, created_at) VALUES(?,?,?)", (profile_id, as_json(payload), now()))
            row = conn.execute("SELECT * FROM calibrations WHERE id=?", (cursor.lastrowid,)).fetchone()
        return {"id": row["id"], "profile_id": row["profile_id"], **from_json(row["payload"], {}), "created_at": row["created_at"]}

    def create_session(self, config: dict[str, Any]) -> dict[str, Any]:
        profile_id = int(config.get("profile_id") or 1)
        title = str(config.get("title") or "Beryl 红点诊断").strip()[:100]
        payload = {
            "weapon": str(config.get("weapon") or "Beryl")[:40],
            "scope": str(config.get("scope") or "红点")[:40],
            "distance": int(self._number(config.get("distance"), 50, 1, 1000)),
            "magazines": int(self._number(config.get("magazines"), 5, 1, 20)),
            "variable": str(config.get("variable") or "none")[:40],
            "strategy": "guided" if config.get("strategy") == "guided" else "linked",
            "conditions": {
                "posture": str((config.get("conditions") or {}).get("posture") or "站姿").strip()[:30],
                "attachments": str((config.get("conditions") or {}).get("attachments") or "无").strip()[:120],
            },
        }
        timestamp = now()
        with self._connect() as conn:
            if not self._profile_exists(conn, profile_id):
                raise ValueError("测试会话对应的参数方案不存在")
            profile_row = conn.execute("SELECT payload FROM profiles WHERE id=?", (profile_id,)).fetchone()
            profile_payload = from_json(profile_row["payload"], DEFAULT_SETTINGS)
            payload["baseline_settings"] = self._normalise_profile_payload(config.get("baseline_settings") or profile_payload)
            cursor = conn.execute("INSERT INTO sessions(profile_id, title, payload, created_at, updated_at) VALUES(?,?,?,?,?)", (profile_id, title, as_json(payload), timestamp, timestamp))
            row = conn.execute("SELECT * FROM sessions WHERE id=?", (cursor.lastrowid,)).fetchone()
        return self._session(row)

    def get_session(self, session_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id=?", (int(session_id),)).fetchone()
            if not row:
                return None
            session = self._session(row)
            session["trials"] = [self._trial(trial) for trial in conn.execute("SELECT * FROM trials WHERE session_id=? ORDER BY trial_number, id", (int(session_id),))]
            rec = conn.execute("SELECT * FROM recommendations WHERE session_id=? ORDER BY id DESC LIMIT 1", (int(session_id),)).fetchone()
            session["recommendation"] = from_json(rec["payload"], None) if rec else None
            return session

    def save_trial(self, trial: dict[str, Any]) -> dict[str, Any]:
        session_id = int(trial.get("session_id") or 0)
        trial_number = int(trial.get("trial_number") or 1)
        metrics = trial.get("metrics") or {}
        payload = {
            "source": "diagnostic" if trial.get("source") == "diagnostic" else "manual",
            "metrics": {
                "vertical_control": self._number(metrics.get("vertical_control"), 3, 1, 5),
                "horizontal_drift": self._number(metrics.get("horizontal_drift"), 3, 1, 5),
                "shake": self._number(metrics.get("shake"), 3, 1, 5),
                "overcompensation": bool(metrics.get("overcompensation", False)),
                "stability": self._number(metrics.get("stability"), 3, 1, 5),
                "score": self._number(metrics.get("score"), 0, 0, 100),
                "retention": self._number(metrics.get("retention"), 0, 0, 100),
            },
            "notes": str(trial.get("notes") or "")[:1000],
            "variable": str(trial.get("variable") or "none")[:40],
            "mode": str(trial.get("mode") or "")[:20],
        }
        timestamp = now()
        with self._connect() as conn:
            if not self._session_exists(conn, session_id):
                raise ValueError("找不到要保存测试结果的会话")
            session_row = conn.execute("SELECT payload FROM sessions WHERE id=?", (session_id,)).fetchone()
            session_payload = from_json(session_row["payload"], {})
            phase = trial.get("phase")
            if phase in {"baseline", "candidate"}:
                payload["phase"] = phase
                payload["candidate_id"] = str(trial.get("candidate_id") or "")[:80] or None
                snapshot = trial.get("settings_snapshot")
                required_settings = set(DEFAULT_SETTINGS)
                required_scopes = set(DEFAULT_SETTINGS["scopes"])
                snapshot_complete = isinstance(snapshot, dict) and required_settings.issubset(snapshot) and isinstance(snapshot.get("scopes"), dict) and required_scopes.issubset(snapshot["scopes"])
                payload["settings_snapshot"] = self._normalise_profile_payload(snapshot) if snapshot_complete else None
                conditions = trial.get("conditions")
                if isinstance(conditions, dict):
                    payload["conditions"] = {
                        "posture": str(conditions.get("posture") or "").strip()[:30],
                        "attachments": str(conditions.get("attachments") or "").strip()[:120],
                    }
                else:
                    payload["conditions"] = deepcopy(session_payload.get("conditions")) if session_payload.get("conditions") else None
                impact = trial.get("impact")
                spread = None
                if isinstance(impact, dict):
                    try:
                        spread = float(impact.get("spread")) if impact.get("spread") is not None else None
                    except (TypeError, ValueError):
                        spread = None
                if isinstance(impact, dict) and impact.get("direction") in {"center", "up", "down", "left", "right"} and spread is not None:
                    payload["impact"] = {
                        "direction": impact["direction"],
                        "spread": int(self._number(spread, 3, 1, 5)),
                    }
                else:
                    payload["impact"] = None
            cursor = conn.execute("INSERT INTO trials(session_id, trial_number, payload, created_at) VALUES(?,?,?,?)", (session_id, trial_number, as_json(payload), timestamp))
            conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (timestamp, session_id))
            row = conn.execute("SELECT * FROM trials WHERE id=?", (cursor.lastrowid,)).fetchone()
        return self._trial(row)

    def run_diagnostic_test(self, mode: str, config: dict[str, Any]) -> dict[str, Any]:
        """返回训练场所需的相对缩放和规则，不模拟 PUBG 内部物理。"""
        mode = mode if mode in {"vertical", "horizontal", "micro"} else "vertical"
        dpi = max(100, float(config.get("dpi") or 1200))
        aim = max(1, float(config.get("aim") or 44))
        ads = max(1, float(config.get("ads") or 46))
        calibration = float(config.get("calibration_factor") or 1.0)
        scale = round((dpi / 800) * ((aim + ads) / 90) * calibration, 3)
        return {"mode": mode, "scale": scale, "duration": 20, "reps": 5, "safe": True}

    @staticmethod
    def _clamp(value: float, low: float = 1, high: float = 100) -> float:
        return round(max(low, min(high, value)), 1)

    @staticmethod
    def _scope_sensitivity(session: dict[str, Any]) -> tuple[str, str]:
        scope = str(session.get("scope") or "红点")
        key = {"红点": "ads", "全息": "ads", "2倍": "scopes.2x", "3倍": "scopes.3x", "4倍": "scopes.4x", "6倍": "scopes.6x", "8倍": "scopes.8x", "15倍": "scopes.15x"}.get(scope)
        return (key or "ads", "开镜模式灵敏度" if key == "ads" else f"{scope}灵敏度")

    @staticmethod
    def _read_setting(settings: dict[str, Any], key: str) -> float:
        if key.startswith("scopes."):
            return float((settings.get("scopes") or {}).get(key.split(".", 1)[1], 1))
        return float(settings.get(key, 1))

    @staticmethod
    def _write_setting(settings: dict[str, Any], key: str, value: float) -> None:
        if key.startswith("scopes."):
            settings.setdefault("scopes", {})[key.split(".", 1)[1]] = value
        else:
            settings[key] = value

    @staticmethod
    def _mean(trials: list[dict[str, Any]], group: str, key: str) -> float:
        values = [float((trial.get("metrics") or {}).get(key) or 0) for trial in trials]
        return sum(values) / len(values) if values else 0.0

    def _make_candidate(self, session: dict[str, Any], baseline: dict[str, Any]) -> tuple[dict[str, Any] | None, str, str]:
        metrics = baseline.get("metrics") or {}
        impact = baseline.get("impact") or {}
        if not impact.get("direction") or impact.get("spread") is None:
            return None, "命中数据未记录", "补录弹着中心方向和散布后再生成候选；旧轮次缺少的数据不会被推测。"
        settings = deepcopy(baseline.get("settings_snapshot") or {})
        if not settings:
            return None, "设置快照缺失", "本轮没有完整参数快照，无法安全比较；请从新会话重新记录基准。"

        v = float(metrics.get("vertical_control", 3))
        h = float(metrics.get("horizontal_drift", 3))
        shake = float(metrics.get("shake", 3))
        overshoot = bool(metrics.get("overcompensation"))
        up_hits = impact.get("direction") == "up"
        vertical_problem = v >= 4 or (up_hits and v >= 3)
        horizontal_problem = h >= 4 or shake >= 4 or overshoot or impact.get("direction") in {"left", "right"}
        diagnosis = "垂直与横向信号互相牵制" if vertical_problem and horizontal_problem else "垂直回拉可能不足" if vertical_problem else "横向控制或抖动较突出" if horizontal_problem else "问题方向尚不明确"
        key, setting_name = self._scope_sensitivity(session)
        strategy = session.get("strategy", "linked")
        changes: list[tuple[str, str, float]] = []

        if vertical_problem and horizontal_problem:
            if strategy == "linked" and up_hits and not overshoot and float(settings.get("vertical_multiplier", 2)) < 2:
                changes = [(key, setting_name, -1), ("vertical_multiplier", "垂直灵敏度增强", 0.1)]
                reason = "弹着仍偏上且横向/抖动也明显，生成小幅联动候选：略降当前瞄准状态灵敏度以约束横向，同时在 2.0 上限内小幅补垂直。两项同时变化，只能比较这组方案，不能单独归因。"
            else:
                return None, "垂直与横向信号冲突", "当前信号互相牵制，且没有安全的垂直补偿空间。保持参数再重复基准，或用诊断训练拆分控制问题；不要把一次主观感受强行转成数值。"
        elif vertical_problem:
            multiplier = float(settings.get("vertical_multiplier", 2))
            if multiplier < 2:
                changes = [("vertical_multiplier", "垂直灵敏度增强", 0.1)]
                reason = "弹着中心偏上并伴随明显垂直上抬。仅小幅提高垂直增强，先验证垂直补偿，不动正在测试的倍镜灵敏度。"
            else:
                changes = [(key, setting_name, 1)]
                reason = "垂直增强已到 2.0 上限，不建议继续加；本候选只小幅提高当前开镜状态实际使用的灵敏度，观察能否更容易向下回拉。"
        elif horizontal_problem:
            changes = [(key, setting_name, -1)]
            reason = "横向偏移、抖动、过补偿或弹着偏左右更突出。候选只小幅降低当前开镜状态实际使用的灵敏度；垂直增强和无关倍镜保持不变。"
        else:
            return None, "问题方向尚不明确", "当前命中与手感信号不足以支持参数变更。保持当前设置再测一组基准，优先保证弹着记录和测试条件一致。"

        candidate = deepcopy(settings)
        applied: list[dict[str, Any]] = []
        for field, label, delta in changes:
            old = self._read_setting(candidate, field)
            high = 2.0 if field == "vertical_multiplier" else 100.0
            new = self._clamp(old + delta, 0.5 if field == "vertical_multiplier" else 1.0, high)
            if new == old:
                continue
            self._write_setting(candidate, field, new)
            applied.append({"field": field, "label": label, "before": old, "after": new})
        if not applied:
            return None, "参数已达可调边界", "建议保持当前参数并复测，或改用逐步排查模式；工具不会建议越界值。"
        return {"settings": candidate, "changes": applied, "reason": reason, "candidate_id": "candidate-1"}, diagnosis, reason

    @staticmethod
    def _compare_trials(baseline: dict[str, Any], candidate: dict[str, Any]) -> tuple[str, str]:
        base_impact, cand_impact = baseline.get("impact") or {}, candidate.get("impact") or {}
        if not base_impact.get("direction") or not cand_impact.get("direction"):
            return "inconclusive", "基准或候选缺少弹着方向/散布记录，暂不能比较。"
        before_dir, after_dir = base_impact["direction"], cand_impact["direction"]
        before_spread, after_spread = int(base_impact.get("spread", 3)), int(cand_impact.get("spread", 3))
        if before_dir != after_dir and before_dir != "center" and after_dir != "center":
            objective = 0
        elif before_dir != after_dir:
            objective = 1 if after_dir == "center" else -1
        elif after_spread < before_spread:
            objective = 1
        elif after_spread > before_spread:
            objective = -1
        else:
            objective = 0

        bm, cm = baseline.get("metrics") or {}, candidate.get("metrics") or {}
        hand_worse = float(cm.get("stability", 3)) <= float(bm.get("stability", 3)) - 1
        hand_worse |= any(float(cm.get(key, 3)) >= float(bm.get(key, 3)) + 1 for key in ("vertical_control", "horizontal_drift", "shake"))
        hand_worse |= bool(cm.get("overcompensation")) and not bool(bm.get("overcompensation"))
        if objective > 0 and hand_worse:
            return "tradeoff", "弹着更接近中心/更集中，但至少一项手感指标明显变差，属于取舍，不能直接认定改善。"
        if objective > 0:
            return "candidate_better", "候选弹着更接近中心或散布更小，且没有触发明显手感恶化约束；仍是初步改善。"
        if objective < 0:
            return "baseline_better", "候选的弹着中心或散布表现变差，暂不接受这组改动。"
        return "inconclusive", "弹着方向/散布没有形成明确改善，或偏移方向变化无法从记录判断；建议按相同条件重复比较。"

    def calculate_recommendation(self, session_id: int) -> dict[str, Any]:
        session = self.get_session(session_id)
        if not session:
            return {"status": "missing_session", "problem": "数据不足", "confidence": "无", "reason": "找不到该测试会话。", "next_step": "重新打开或创建会话。", "changes": []}
        all_trials = session.get("trials", [])
        trials = [item for item in all_trials if item.get("phase") in {"baseline", "candidate"}]
        legacy_manual = [item for item in all_trials if item.get("source") == "manual" and not item.get("phase")]
        if not trials and legacy_manual:
            result = {"status": "legacy_uncomparable", "problem": "旧记录不可直接比较", "confidence": "无", "reason": "历史轮次没有参数快照、弹着方向/散布或基准/候选标记。数据已保留，但不会补猜，也不会生成确定数值建议。", "next_step": "创建新会话，先按当前完整参数记录基准。", "changes": [], "candidate": None, "next_phase": "baseline"}
            return self._save_recommendation(session_id, result)
        if not trials:
            result = {"status": "baseline_required", "problem": "等待当前设置基准", "confidence": "无", "reason": "先按当前参数完成一组测试。基准之前不生成候选数值。", "next_step": "使用当前方案，在 PUBG 完成约 5 个弹匣并记录弹着方向与散布。", "changes": [], "candidate": None, "next_phase": "baseline"}
            return self._save_recommendation(session_id, result)

        baseline_trials = [item for item in trials if item.get("phase") == "baseline"]
        candidate_trials = [item for item in trials if item.get("phase") == "candidate" and item.get("candidate_id") == "candidate-1"]
        latest_baseline = baseline_trials[-1] if baseline_trials else None
        prior = session.get("recommendation") or {}
        candidate = prior.get("candidate")
        problem = "根据基准信号准备候选"
        reason = ""
        if not candidate and latest_baseline:
            candidate, problem, reason = self._make_candidate(session, latest_baseline)
        if candidate and isinstance(candidate, dict) and "settings" not in candidate:
            candidate = None

        comparison = None
        verdict = "not_tested"
        compare_reason = "候选尚未完成 PUBG 实测。"
        if latest_baseline and candidate_trials:
            paired = list(zip(baseline_trials, candidate_trials))
            pair_results = []
            for base_trial, candidate_trial in paired:
                if base_trial.get("conditions") != candidate_trial.get("conditions"):
                    pair_results.append(("inconclusive", "基准与候选测试条件不同（姿势或配件不一致），本组比较无效。"))
                else:
                    pair_results.append(self._compare_trials(base_trial, candidate_trial))
            pair_verdicts = [item[0] for item in pair_results]
            if "tradeoff" in pair_verdicts:
                verdict = "tradeoff"
            elif pair_verdicts and all(item == "candidate_better" for item in pair_verdicts):
                verdict = "candidate_better"
            elif pair_verdicts and all(item == "baseline_better" for item in pair_verdicts):
                verdict = "baseline_better"
            else:
                verdict = "inconclusive"
            compare_reason = pair_results[-1][1]
            if len(set(pair_verdicts)) > 1:
                compare_reason = "重复比较结果不一致，暂不能判断哪组更好。"
            comparison = {
                "verdict": verdict,
                "baseline_trial": latest_baseline.get("trial_number"),
                "candidate_trial": candidate_trials[-1].get("trial_number"),
                "pair_count": len(paired),
                "pair_verdicts": pair_verdicts,
                "reason": compare_reason,
            }

        # Balanced repeat count makes order and fatigue effects visible instead of over-weighting one side.
        baseline_count, candidate_count = len(baseline_trials), len(candidate_trials)
        if not candidate:
            next_phase = "baseline"
            next_step = "保持当前参数，再记录一组基准；确认每组都是同一距离、姿势和配件，并填写弹着方向/散布。"
            confidence = "不足"
            changes = []
        elif not candidate_trials:
            next_phase = "candidate"
            next_step = "按下方变更表在 PUBG 手动设置候选值，只测试表中改动；完成约 5 个弹匣后确认已应用并记录。"
            confidence = "初步（只有基准）"
            changes = candidate.get("changes", [])
        else:
            next_phase = "baseline" if baseline_count <= candidate_count else "candidate"
            if baseline_count >= 2 and candidate_count >= 2 and verdict in {"candidate_better", "baseline_better"}:
                confidence = "较可信（至少两组/侧）"
            else:
                confidence = "初步（需要平衡复测）"
            if verdict == "candidate_better":
                problem = "候选初步改善" if baseline_count < 2 or candidate_count < 2 else "候选重复表现更好"
                next_step = "不要立刻继续加码。两侧数量相同时，下一组先用原基准值测试，再补一组候选；若数量不同，先补测较少的一侧。场景条件保持不变。"
            elif verdict == "baseline_better":
                problem = "当前基准表现更好"
                next_step = "暂不接受候选。两侧数量相同时，下一组先用原基准值测试，再补一组候选；若数量不同，先补测较少的一侧。若趋势重复，再回到基准值。"
            elif verdict == "tradeoff":
                problem = "命中改善与手感存在取舍"
                next_step = "暂不判优。两侧数量相同时先补基准，之后补候选；若数量不同先补较少一侧，并重点看变差的手感是否重复出现。"
            else:
                problem = "暂不能判断"
                next_step = "两组结果接近或互相矛盾；两侧数量相同时下一组先补基准，数量不同时补较少一侧，不要根据一轮就定结论。"
            changes = candidate.get("changes", [])
        result = {
            "status": "candidate_ready" if candidate and not candidate_trials else (verdict if candidate_trials else "need_repeat"),
            "problem": problem,
            "confidence": confidence,
            "reason": (candidate or {}).get("reason", reason or "当前证据不足，保持参数。"),
            "next_step": next_step,
            "next_phase": next_phase,
            "candidate": candidate,
            "changes": changes,
            "comparison": comparison,
            "stop_rule": "至少完成两组基准和两组候选；命中方向/散布保持改善且手感没有明显恶化时，可停止微调。",
            "summary": {
                "baseline_count": baseline_count,
                "candidate_count": candidate_count,
                "vertical": round(self._mean(baseline_trials, "baseline", "vertical_control"), 1),
                "horizontal": round(self._mean(baseline_trials, "baseline", "horizontal_drift"), 1),
                "shake": round(self._mean(baseline_trials, "baseline", "shake"), 1),
            },
        }
        return self._save_recommendation(session_id, result)

    def _save_recommendation(self, session_id: int, result: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as conn:
            conn.execute("INSERT INTO recommendations(session_id, payload, created_at) VALUES(?,?,?)", (int(session_id), as_json(result), now()))
        return result

    def export_session(self, session_id: int, format: str = "json") -> str:
        session = self.get_session(session_id)
        if not session:
            raise ValueError("找不到测试会话")
        profile = next(
            (item for item in self.load_profiles()["profiles"] if item["id"] == session.get("profile_id")),
            None,
        )
        stamp = time.strftime("%Y%m%d_%H%M%S")
        safe_format = "csv" if str(format).lower() == "csv" else "json"
        path = self.export_dir / f"pubg_session_{session_id}_{stamp}.{safe_format}"
        if safe_format == "json":
            bundle = {
                "schema_version": 2,
                "exported_at": now(),
                "profile": profile,
                "session": session,
            }
            path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["轮次", "阶段", "候选编号", "来源", "枪械", "倍镜", "距离米", "姿势", "配件", "弹着方向", "散布1至5", "完整灵敏度快照JSON", "垂直控制严重度", "水平偏移严重度", "抖动严重度", "过补偿", "稳定评分", "诊断得分", "目标保持率", "备注"])
            for trial in session.get("trials", []):
                m = trial.get("metrics", {})
                impact, conditions = trial.get("impact") or {}, trial.get("conditions") or {}
                snapshot = as_json(trial.get("settings_snapshot")) if trial.get("settings_snapshot") else ""
                writer.writerow([trial.get("trial_number"), trial.get("phase", ""), trial.get("candidate_id", ""), trial.get("source", ""), session.get("weapon", ""), session.get("scope", ""), session.get("distance", ""), conditions.get("posture", ""), conditions.get("attachments", ""), impact.get("direction", ""), impact.get("spread", ""), snapshot, m.get("vertical_control", ""), m.get("horizontal_drift", ""), m.get("shake", ""), m.get("overcompensation", ""), m.get("stability", ""), m.get("score", ""), m.get("retention", ""), trial.get("notes", "")])
            path.write_text(output.getvalue(), encoding="utf-8-sig")
        return str(path)

    def pick_import_file(self) -> str:
        """通过桌面文件选择器选择会话 JSON。"""
        try:
            windows = getattr(webview, "windows", [])
            if not windows:
                return ""
            result = windows[0].create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("JSON 会话 (*.json)",),
            )
            return str(result[0]) if result else ""
        except Exception:
            return ""

    def import_session(self, file_path: str) -> dict[str, Any]:
        path = Path(file_path)
        if path.suffix.lower() != ".json":
            raise ValueError("目前只支持导入 JSON 会话")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON 内容不是有效的会话对象")
        session_data = data.get("session", data)
        profile_data = data.get("profile") or DEFAULT_SETTINGS
        if not isinstance(session_data, dict) or not isinstance(profile_data, dict):
            raise ValueError("JSON 会话结构不完整")
        profile = self.save_profile({
            "name": f"导入方案 · {profile_data.get('name', path.stem)}",
            **self._normalise_profile_payload(profile_data),
        })
        session = self.create_session({
            "profile_id": profile["id"],
            "title": f"导入 · {session_data.get('title', path.stem)}",
            "weapon": session_data.get("weapon", "Beryl"),
            "scope": session_data.get("scope", "红点"),
            "distance": session_data.get("distance", 50),
            "magazines": session_data.get("magazines", 5),
            "variable": session_data.get("variable", "none"),
            "strategy": session_data.get("strategy", "linked"),
            "conditions": session_data.get("conditions", {"posture": "站姿", "attachments": "无"}),
            "baseline_settings": session_data.get("baseline_settings") or profile_data,
        })
        trials = session_data.get("trials", [])
        if not isinstance(trials, list):
            raise ValueError("JSON 中的测试记录格式错误")
        for trial in trials:
            if not isinstance(trial, dict):
                continue
            self.save_trial({
                "session_id": session["id"],
                "trial_number": trial.get("trial_number", 1),
                "source": trial.get("source", "manual"),
                "metrics": trial.get("metrics", {}),
                "notes": trial.get("notes", ""),
                "variable": trial.get("variable", "none"),
                "mode": trial.get("mode", ""),
                "phase": trial.get("phase"),
                "candidate_id": trial.get("candidate_id"),
                "settings_snapshot": trial.get("settings_snapshot"),
                "conditions": trial.get("conditions"),
                "impact": trial.get("impact"),
            })
        if trials:
            self.calculate_recommendation(session["id"])
        return self.get_session(session["id"]) or session

    def duplicate_session(self, session_id: int) -> dict[str, Any]:
        """复制会话及其轮次，保留原记录并创建可继续测试的新会话。"""
        source = self.get_session(session_id)
        if not source:
            raise ValueError("找不到要复制的测试会话")
        copied = self.create_session({
            "profile_id": source["profile_id"],
            "title": f"{source['title']} · 副本",
            "weapon": source.get("weapon", "Beryl"),
            "scope": source.get("scope", "红点"),
            "distance": source.get("distance", 50),
            "magazines": source.get("magazines", 5),
            "variable": source.get("variable", "none"),
            "strategy": source.get("strategy", "linked"),
            "conditions": source.get("conditions", {"posture": "站姿", "attachments": "无"}),
            "baseline_settings": source.get("baseline_settings"),
        })
        for trial in source.get("trials", []):
            self.save_trial({
                "session_id": copied["id"],
                "trial_number": trial.get("trial_number", 1),
                "source": trial.get("source", "manual"),
                "metrics": trial.get("metrics", {}),
                "notes": trial.get("notes", ""),
                "variable": trial.get("variable", "none"),
                "mode": trial.get("mode", ""),
                "phase": trial.get("phase"),
                "candidate_id": trial.get("candidate_id"),
                "settings_snapshot": trial.get("settings_snapshot"),
                "conditions": trial.get("conditions"),
                "impact": trial.get("impact"),
            })
        if source.get("trials"):
            self.calculate_recommendation(copied["id"])
        return self.get_session(copied["id"]) or copied

    def delete_session(self, session_id: int) -> bool:
        with self._connect() as conn:
            conn.execute("DELETE FROM trials WHERE session_id=?", (int(session_id),))
            conn.execute("DELETE FROM recommendations WHERE session_id=?", (int(session_id),))
            conn.execute("DELETE FROM sessions WHERE id=?", (int(session_id),))
        return True
