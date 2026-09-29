# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend import Backend


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pubg_lab_tests_")
        self.backend = Backend(Path(self.temp.name))
        self.profile = self.backend.load_profiles()["profiles"][0]

    def tearDown(self):
        self.temp.cleanup()

    def create_session(self, title="test", scope="红点", strategy="linked", vertical=2.0):
        self.profile = self.backend.save_profile({**self.profile, "vertical_multiplier": vertical})
        return self.backend.create_session({
            "profile_id": self.profile["id"], "title": title, "weapon": "Beryl", "scope": scope,
            "distance": 50, "magazines": 5, "strategy": strategy,
            "conditions": {"posture": "站姿", "attachments": "补偿器、垂直握把、枪托"},
        })

    @staticmethod
    def metrics(vertical=2, horizontal=2, shake=2, stability=4, overcompensation=False):
        return {"vertical_control": vertical, "horizontal_drift": horizontal, "shake": shake,
                "stability": stability, "overcompensation": overcompensation}

    def save_round(self, session, phase, number, metrics=None, direction="up", spread=4, candidate=None, conditions=None):
        return self.backend.save_trial({
            "session_id": session["id"], "trial_number": number, "source": "manual", "phase": phase,
            "candidate_id": (candidate or {}).get("candidate_id") if phase == "candidate" else None,
            "settings_snapshot": (candidate or {}).get("settings") if phase == "candidate" else session["baseline_settings"],
            "conditions": conditions or session["conditions"],
            "impact": {"direction": direction, "spread": spread},
            "metrics": metrics or self.metrics(), "notes": f"轮次 {number}",
        })

    def baseline_then_candidate(self, session, baseline_metrics=None, direction="up", spread=4):
        self.save_round(session, "baseline", 1, baseline_metrics or self.metrics(vertical=4, horizontal=2), direction, spread)
        recommendation = self.backend.calculate_recommendation(session["id"])
        self.assertIsNotNone(recommendation["candidate"])
        return recommendation

    def test_default_profile_and_normalisation(self):
        self.assertEqual(self.profile["dpi"], 1200)
        saved = self.backend.save_profile({**self.profile, "dpi": -1, "vertical_multiplier": 9, "windows_pointer_speed": 99})
        self.assertEqual(saved["dpi"], 100)
        self.assertEqual(saved["vertical_multiplier"], 2.0)
        self.assertEqual(saved["windows_pointer_speed"], 11)

    def test_latest_calibration_wins(self):
        self.backend.save_calibration({"profile_id": self.profile["id"], "distance_cm": 20, "degrees": 150, "repeats": 2, "factor": 0.8})
        latest = self.backend.save_calibration({"profile_id": self.profile["id"], "distance_cm": 20, "degrees": 210, "repeats": 4, "factor": 1.2})
        loaded = self.backend.load_profiles()["calibrations"][str(self.profile["id"])]
        self.assertEqual(loaded["id"], latest["id"])
        self.assertEqual(loaded["factor"], 1.2)

    def test_session_requires_baseline_before_candidate(self):
        session = self.create_session()
        empty = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(empty["status"], "baseline_required")
        self.assertIsNone(empty["candidate"])
        self.assertEqual(empty["next_phase"], "baseline")
        self.save_round(session, "baseline", 1, self.metrics(vertical=4), "up", 4)
        candidate = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(candidate["status"], "candidate_ready")
        self.assertEqual(candidate["problem"], "垂直回拉可能不足")
        self.assertEqual(candidate["next_phase"], "candidate")
        self.assertTrue(candidate["changes"])

    def test_red_dot_maps_to_ads_and_ignores_legacy_red_dot_44(self):
        session = self.create_session()
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4, horizontal=2), "up", 5)
        changes = recommendation["changes"]
        self.assertEqual([(item["field"], item["before"], item["after"]) for item in changes], [("ads", 46.0, 47.0)])
        self.assertEqual(recommendation["candidate"]["settings"]["scopes"]["red_dot"], 44)

    def test_scope_recommendation_changes_only_active_scope(self):
        session = self.create_session(scope="3倍")
        result = self.baseline_then_candidate(session, self.metrics(vertical=2, horizontal=4, shake=4), "left", 5)
        self.assertEqual(result["changes"][0]["field"], "scopes.3x")
        settings = result["candidate"]["settings"]
        self.assertEqual(settings["scopes"]["3x"], 39)
        self.assertEqual(settings["scopes"]["2x"], 38)
        self.assertEqual(settings["ads"], 46)

    def test_vertical_multiplier_is_bounded_and_at_cap_uses_active_scope(self):
        below_cap = self.create_session("below", vertical=1.9)
        result = self.baseline_then_candidate(below_cap, self.metrics(vertical=4, horizontal=1), "up", 5)
        self.assertEqual(result["changes"][0]["field"], "vertical_multiplier")
        self.assertEqual(result["candidate"]["settings"]["vertical_multiplier"], 2.0)

        at_cap = self.create_session("cap", vertical=2.0)
        result = self.baseline_then_candidate(at_cap, self.metrics(vertical=4, horizontal=1), "up", 5)
        self.assertEqual(result["changes"][0]["field"], "ads")
        self.assertLessEqual(result["candidate"]["settings"]["vertical_multiplier"], 2.0)

    def test_linked_strategy_can_offer_two_parameter_bundle(self):
        session = self.create_session(vertical=1.8)
        result = self.baseline_then_candidate(session, self.metrics(vertical=4, horizontal=4, shake=4), "up", 5)
        self.assertEqual([item["field"] for item in result["changes"]], ["ads", "vertical_multiplier"])
        self.assertEqual(result["candidate"]["settings"]["ads"], 45)
        self.assertEqual(result["candidate"]["settings"]["vertical_multiplier"], 1.9)

    def test_guided_strategy_does_not_force_a_conflicting_candidate(self):
        session = self.create_session(strategy="guided", vertical=1.8)
        self.save_round(session, "baseline", 1, self.metrics(vertical=4, horizontal=4, shake=4), "up", 5)
        result = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(result["status"], "need_repeat")
        self.assertIsNone(result["candidate"])

    def test_improvement_requires_hit_gain_without_obvious_feel_regression(self):
        session = self.create_session()
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4, horizontal=2, shake=2, stability=3), "up", 5)
        self.save_round(session, "candidate", 2, self.metrics(vertical=3, horizontal=2, shake=2, stability=3), "center", 3, recommendation["candidate"])
        compared = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(compared["comparison"]["verdict"], "candidate_better")
        self.assertEqual(compared["next_phase"], "baseline")
        self.assertIn("初步", compared["confidence"])

    def test_hit_gain_with_handfeel_regression_is_tradeoff(self):
        session = self.create_session()
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4, horizontal=2, shake=2, stability=4), "up", 5)
        self.save_round(session, "candidate", 2, self.metrics(vertical=2, horizontal=3, shake=2, stability=2), "center", 3, recommendation["candidate"])
        compared = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(compared["comparison"]["verdict"], "tradeoff")

    def test_same_or_conflicting_hit_results_are_inconclusive(self):
        session = self.create_session()
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4), "up", 4)
        self.save_round(session, "candidate", 2, self.metrics(vertical=4), "up", 4, recommendation["candidate"])
        result = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(result["comparison"]["verdict"], "inconclusive")
        self.assertIn("暂不能判断", result["problem"])

    def test_repeated_comparisons_need_consistent_pairs(self):
        session = self.create_session()
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4), "up", 5)
        self.save_round(session, "candidate", 2, self.metrics(vertical=3), "center", 3, recommendation["candidate"])
        self.save_round(session, "baseline", 3, self.metrics(vertical=4), "up", 5)
        self.save_round(session, "candidate", 4, self.metrics(vertical=3), "center", 3, recommendation["candidate"])
        result = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(result["comparison"]["verdict"], "candidate_better")
        self.assertEqual(result["comparison"]["pair_count"], 2)
        self.assertIn("较可信", result["confidence"])

    def test_condition_mismatch_invalidates_comparison(self):
        session = self.create_session()
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4), "up", 5)
        self.save_round(session, "candidate", 2, self.metrics(vertical=3), "center", 3, recommendation["candidate"], {"posture": "蹲姿", "attachments": "无"})
        result = self.backend.calculate_recommendation(session["id"])
        self.assertEqual(result["comparison"]["verdict"], "inconclusive")
        self.assertIn("条件不同", result["comparison"]["reason"])

    def test_old_records_stay_uncomparable_and_do_not_get_invented_hit_data(self):
        session = self.create_session()
        self.backend.save_trial({"session_id": session["id"], "trial_number": 1, "source": "manual", "metrics": self.metrics(vertical=4)})
        result = self.backend.calculate_recommendation(session["id"])
        loaded = self.backend.get_session(session["id"])
        self.assertEqual(result["status"], "legacy_uncomparable")
        self.assertNotIn("impact", loaded["trials"][0])
        self.assertNotIn("settings_snapshot", loaded["trials"][0])

    def test_incomplete_new_snapshots_and_impact_are_not_filled_with_defaults(self):
        session = self.create_session("incomplete")
        saved = self.backend.save_trial({
            "session_id": session["id"], "trial_number": 1, "source": "manual", "phase": "baseline",
            "settings_snapshot": {"ads": 46}, "conditions": session["conditions"],
            "impact": {"direction": "up"}, "metrics": self.metrics(vertical=4),
        })
        self.assertIsNone(saved["settings_snapshot"])
        self.assertIsNone(saved["impact"])
        recommendation = self.backend.calculate_recommendation(session["id"])
        self.assertIsNone(recommendation["candidate"])
        self.assertEqual(recommendation["problem"], "命中数据未记录")

    def test_schema_v1_json_import_keeps_missing_fields_unknown(self):
        legacy = {
            "schema_version": 1,
            "profile": {"name": "旧方案", "dpi": 800},
            "session": {"title": "旧实战记录", "weapon": "Beryl", "scope": "红点", "distance": 50,
                        "trials": [{"trial_number": 1, "source": "manual", "metrics": self.metrics(vertical=4)}]},
        }
        with tempfile.TemporaryDirectory(prefix="pubg_legacy_export_") as folder:
            source = Path(folder) / "legacy.json"
            source.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
            imported = self.backend.import_session(str(source))
        self.assertIsNone(imported["trials"][0].get("impact"))
        self.assertIsNone(imported["trials"][0].get("settings_snapshot"))
        self.assertEqual(imported["recommendation"]["status"], "legacy_uncomparable")

    def test_export_import_preserves_new_fields_and_recommendation(self):
        session = self.create_session("roundtrip")
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4), "up", 5)
        self.save_round(session, "candidate", 2, self.metrics(vertical=3), "center", 3, recommendation["candidate"])
        self.backend.calculate_recommendation(session["id"])
        exported = self.backend.export_session(session["id"], "json")
        bundle = json.loads(Path(exported).read_text(encoding="utf-8"))
        self.assertEqual(bundle["schema_version"], 2)
        with tempfile.TemporaryDirectory(prefix="pubg_lab_import_") as second:
            target = Backend(Path(second))
            imported = target.import_session(exported)
            self.assertEqual(len(imported["trials"]), 2)
            self.assertEqual(imported["trials"][0]["settings_snapshot"]["ads"], 46)
            self.assertEqual(imported["trials"][0]["impact"], {"direction": "up", "spread": 5})
            self.assertEqual(imported["trials"][1]["phase"], "candidate")
            self.assertEqual(imported["recommendation"]["comparison"]["verdict"], "candidate_better")

    def test_duplicate_session_preserves_conditions_and_trial_snapshots(self):
        session = self.create_session("复制来源")
        recommendation = self.baseline_then_candidate(session, self.metrics(vertical=4), "up", 5)
        self.save_round(session, "candidate", 2, self.metrics(vertical=3), "center", 3, recommendation["candidate"])
        copied = self.backend.duplicate_session(session["id"])
        self.assertNotEqual(copied["id"], session["id"])
        self.assertEqual(copied["conditions"], session["conditions"])
        self.assertEqual(copied["trials"][1]["settings_snapshot"]["ads"], 47)
        self.assertEqual(copied["trials"][1]["phase"], "candidate")

    def test_csv_export_contains_experiment_context(self):
        session = self.create_session("csv")
        self.save_round(session, "baseline", 1, self.metrics(vertical=4), "up", 5)
        exported = self.backend.export_session(session["id"], "csv")
        content = Path(exported).read_text(encoding="utf-8-sig")
        self.assertIn("弹着方向", content)
        self.assertIn("完整灵敏度快照JSON", content)
        self.assertIn("补偿器、垂直握把、枪托", content)

    def test_invalid_relations_are_rejected(self):
        with self.assertRaises(ValueError):
            self.backend.create_session({"profile_id": 9999})
        with self.assertRaises(ValueError):
            self.backend.save_trial({"session_id": 9999, "metrics": {}})
        with self.assertRaises(ValueError):
            self.backend.save_calibration({"profile_id": 9999})

    def test_calibration_changes_diagnostic_scale(self):
        base = self.backend.run_diagnostic_test("vertical", {"dpi": 1200, "aim": 44, "ads": 46, "calibration_factor": 1})
        calibrated = self.backend.run_diagnostic_test("vertical", {"dpi": 1200, "aim": 44, "ads": 46, "calibration_factor": 1.2})
        self.assertGreater(calibrated["scale"], base["scale"])


if __name__ == "__main__":
    unittest.main()
