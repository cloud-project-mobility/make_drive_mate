import copy
import json
import unittest
from unittest.mock import patch

from assistant_worker import parse_request, respond, validate_answer
from onbid_worker import WorkerError


def request():
    return {"question": "지금 팔기 전에 무엇을 비교해야 하나요?", "context": {
        "demo": False, "vehicle": {"powertrain": "ICE", "odometer_km": 12000},
        "maintenance": [{"item": "engine-oil", "status": "unrecorded", "recorded": False}], "next_plan": None}}


class AssistantTests(unittest.TestCase):
    def test_question_and_safe_records_round_trip(self):
        value = request()
        value["question"] = "K5나 아이오닉5도 상담할 수 있나요?"
        self.assertEqual(parse_request(json.dumps(value).encode()), value)

    def test_private_context_and_client_price_are_not_accepted(self):
        for field in ("address", "latitude", "note", "email", "facts", "prediction_krw"):
            value = request()
            value["context"][field] = "private-synthetic"
            with self.assertRaises(WorkerError):
                parse_request(json.dumps(value).encode())
        value = request()
        value["analysis"] = {"vehicle": {"model": "K5", "age_years": 5, "odometer_km": 12000}, "prediction_krw": 1}
        with self.assertRaises(WorkerError):
            parse_request(json.dumps(value).encode())

    def test_schedule_does_not_allow_destinations_and_invalid_dates(self):
        base = {"event_at": "2026-11-06T09:00:00Z", "departure_at": None, "route_fresh": False, "sample": False}
        value = request()
        value["context"]["next_plan"] = base
        self.assertEqual(parse_request(json.dumps(value).encode())["context"]["next_plan"], base)
        for update in ({"destination": "private"}, {"event_at": "2026-99-99T09:00:00Z"}):
            modified = copy.deepcopy(value)
            modified["context"]["next_plan"].update(update)
            with self.assertRaises(WorkerError):
                parse_request(json.dumps(modified).encode())

    def test_duplicate_keys_boolean_numbers_and_unknown_fields_rejected(self):
        with self.assertRaises(WorkerError):
            parse_request(b'{"question":"a","question":"b","context":{}}')
        value = request()
        value["context"]["vehicle"]["odometer_km"] = True
        with self.assertRaises(WorkerError):
            parse_request(json.dumps(value).encode())

    def test_freeform_question_reaches_provider_with_verified_fact_selection(self):
        seen = []
        def selector(prompt):
            seen.append(json.loads(prompt))
            return json.dumps({"status": "answered", "answer": "교체 기록을 먼저 확인하고 제조사 매뉴얼과 비교해 보세요.", "fact_ids": ["maintenance_engine-oil"]})
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("No network")):
            result = respond(request(), selector)
        self.assertEqual(seen[0]["question"], request()["question"])
        self.assertEqual(result["status"], "answered")
        self.assertIn("maintenance_engine-oil", [f["id"] for f in result["facts"]])
        self.assertFalse(result["price_generation_by_llm"])

    def test_numeric_hallucination_unknown_id_and_name_echo_abstain(self):
        for answer, ids in [("천만원에 파세요", []), ("가격은 2500입니다", []), ("K5가 좋아요", []), ("일 년 뒤 팔아요", []), ("한 달 기다려요", []), ("삼천 원이에요", []), ("설명입니다", ["invented"])]:
            result = respond(request(), lambda _: json.dumps({"status": "answered", "answer": answer, "fact_ids": ids}))
            self.assertEqual(result["status"], "abstained")
            self.assertNotIn(answer, result["answer"])

    def test_model_names_remain_allowed_in_original_facts_not_generated_numbers(self):
        facts = [{"id": "comparison_1", "kind": "evidence", "statement": "K5 · 800만원"}]
        answer, selected = validate_answer({"status": "answered", "answer": "선택한 차량의 비교 근거를 확인해 보세요.", "fact_ids": ["comparison_1"]}, facts)
        self.assertEqual(selected, facts)
        self.assertNotIn("800", answer)

    def test_ordinary_korean_words_are_not_numeric_claims(self):
        for answer in ["공매 조건을 비교하세요.", "세대와 트림을 구분하고 공매 조건을 확인하세요.",
                       "사건별 정보가 달라요.", "한참 기다리는 판단을 보장하지 않아요.", "몇가지 근거를 확인하세요.",
                       "만일 조건이 바뀌면 다시 확인하세요.", "백분율의 의미는 근거와 함께 확인하세요."]:
            result = respond(request(), lambda _, answer=answer: json.dumps({"status": "answered", "answer": answer, "fact_ids": []}))
            self.assertEqual(result["status"], "answered")
            self.assertEqual(result["answer"], answer)
        for answer in ["삼천원이에요.", "일조 원이에요.", "십이개월 뒤예요.", "사 건이에요.", "세 대예요.", "구 분 기다려요."]:
            result = respond(request(), lambda _, answer=answer: json.dumps({"status": "answered", "answer": answer, "fact_ids": []}))
            self.assertEqual(result["status"], "abstained")

    def test_model_input_never_enables_second_llm_call(self):
        value = request()
        value["analysis"] = {"vehicle": {"model": "K5", "age_years": 5, "odometer_km": 12000}, "use_llm": True}
        with self.assertRaises(WorkerError):
            parse_request(json.dumps(value).encode())


if __name__ == "__main__":
    unittest.main()
