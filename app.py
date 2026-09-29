# -*- coding: utf-8 -*-
"""PUBG 灵敏度诊断工具桌面入口。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import webview

from backend import Backend


def resource_path(relative: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, relative)


def main() -> None:
    backend = Backend()
    webview.create_window(
        "PUBG 灵敏度诊断工具",
        url=resource_path(os.path.join("web", "index.html")),
        js_api=backend,
        width=1440,
        height=920,
        min_size=(1120, 720),
    )
    webview.start(debug=False)


def run_self_test(output_path: str) -> int:
    """无界面验收：验证默认档案、会话、推荐和导出链路。"""
    report = {"ok": False}
    try:
        with tempfile.TemporaryDirectory(prefix="pubg_sensitivity_lab_test_") as temp_dir:
            backend = Backend(Path(temp_dir))
            state = backend.load_profiles()
            profile = state["profiles"][0]
            session = backend.create_session({
                "profile_id": profile["id"],
                "title": "Beryl 红点 50米验收",
                "weapon": "Beryl",
                "scope": "红点",
                "distance": 50,
                "magazines": 5,
                "strategy": "linked",
                "conditions": {"posture": "站姿", "attachments": "无"},
                "baseline_settings": profile,
            })
            backend.save_trial({
                "session_id": session["id"], "trial_number": 1, "source": "manual", "phase": "baseline",
                "settings_snapshot": profile, "conditions": session["conditions"],
                "impact": {"direction": "up", "spread": 5},
                "metrics": {"vertical_control": 4, "horizontal_drift": 2, "shake": 2, "overcompensation": False, "stability": 3},
                "notes": "self-test baseline",
            })
            suggestion = backend.calculate_recommendation(session["id"])
            candidate = suggestion.get("candidate") or {}
            backend.save_trial({
                "session_id": session["id"], "trial_number": 2, "source": "manual", "phase": "candidate",
                "candidate_id": candidate.get("candidate_id"), "settings_snapshot": candidate.get("settings"),
                "conditions": session["conditions"], "impact": {"direction": "center", "spread": 3},
                "metrics": {"vertical_control": 3, "horizontal_drift": 2, "shake": 2, "overcompensation": False, "stability": 3},
                "notes": "self-test candidate",
            })
            recommendation = backend.calculate_recommendation(session["id"])
            export = backend.export_session(session["id"], "json")
            export_created = Path(export).is_file()
            report = {
                "ok": bool(profile and session and recommendation.get("comparison", {}).get("verdict") == "candidate_better" and export_created),
                "profile_id": profile["id"],
                "session_id": session["id"],
                "recommendation": recommendation,
                "export_created": export_created,
            }
    except Exception as exc:  # pragma: no cover
        report["error"] = f"{type(exc).__name__}: {exc}"
    Path(output_path).write_text(__import__("json").dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--self-test":
        raise SystemExit(run_self_test(sys.argv[2]))
    main()
