"""Stable IDs for auto-generated test queries (support ticket: standardize
auto-generated questions with imported sets — ID, category, source, notes)."""

import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import kb_test_query_ids as ids
from app.services.kb_test_query_ids import (
    AutoQueryIdAllocator,
    auto_query_id,
    auto_query_notes,
    backfill_auto_query_ids,
    kb_id_prefix,
    next_auto_query_number,
)


class TestPrefix:
    def test_single_word_title_keeps_the_word(self):
        assert kb_id_prefix("FCOI", "abc") == "FCOI"

    def test_numerals_yield_to_words_in_a_mixed_title(self):
        assert kb_id_prefix("2 CFR 200") == "CFR"
        assert kb_id_prefix("2 CFR 200 Uniform Guidance") == "CUG"
        assert kb_id_prefix("2024") == "2024"

    def test_single_long_word_is_capped(self):
        assert kb_id_prefix("Handbook", "abc") == "HANDBO"

    def test_multi_word_title_takes_initials(self):
        assert kb_id_prefix("Export Control Regulations", "abc") == "ECR"

    def test_filler_words_do_not_pollute_the_prefix(self):
        assert kb_id_prefix("FCOI Knowledge Base", "abc") == "FCOI"
        assert kb_id_prefix("Guide to the Common Rule", "abc") == "GCR"

    def test_initials_are_capped_at_five(self):
        assert kb_id_prefix("Alpha Beta Gamma Delta Epsilon Zeta", "abc") == "ABGDE"

    def test_empty_or_punctuation_title_falls_back_to_uuid(self):
        assert kb_id_prefix("", "9f8e7d6c") == "KB9F8E"
        assert kb_id_prefix("???", "9f8e7d6c") == "KB9F8E"
        assert kb_id_prefix(None, "") == "KB"

    def test_one_letter_title_is_padded_from_uuid(self):
        assert kb_id_prefix("X", "9f8e") == "KB9F8E"

    def test_non_string_title_does_not_crash(self):
        assert kb_id_prefix(MagicMock(), "9f8e") == "KB9F8E"


class TestNumbering:
    def test_format_is_zero_padded_to_three(self):
        assert auto_query_id("FCOI", 7) == "FCOI-AUTO-Q007"
        assert auto_query_id("FCOI", 1234) == "FCOI-AUTO-Q1234"

    def test_starts_at_one_on_an_empty_kb(self):
        assert next_auto_query_number([]) == 1
        assert next_auto_query_number([None, "", "SUB-002"]) == 1

    def test_continues_past_the_highest_existing_auto_id(self):
        assert next_auto_query_number(["FCOI-AUTO-Q003", "FCOI-AUTO-Q010", "SUB-002"]) == 11

    def test_counts_auto_ids_under_an_old_prefix(self):
        """A renamed KB changes the prefix; the sequence must not restart."""
        assert next_auto_query_number(["OLD-AUTO-Q004"]) == 5

    @pytest.mark.asyncio
    async def test_reserve_skips_an_id_another_writer_took_since_the_read(self):
        """Two generations that read the same IDs must not both mint Q003."""
        alloc = AutoQueryIdAllocator("FCOI", ["FCOI-AUTO-Q002"])
        taken = {"FCOI-AUTO-Q003"}
        tq = MagicMock()
        tq.find_one = AsyncMock(side_effect=lambda q: MagicMock() if q["external_id"] in taken else None)
        with patch("app.models.kb_test_query.KBTestQuery", tq):
            assert await alloc.reserve("kb-1") == "FCOI-AUTO-Q004"
        assert tq.find_one.call_args_list[0].args[0] == {"knowledge_base_uuid": "kb-1", "external_id": "FCOI-AUTO-Q003"}

    @pytest.mark.asyncio
    async def test_reserve_ignores_the_row_being_backfilled(self):
        """A concurrent backfill's own write to the same row is not a collision."""
        alloc = AutoQueryIdAllocator("FCOI", [])
        tq = MagicMock()
        tq.find_one = AsyncMock(return_value=None)
        with patch("app.models.kb_test_query.KBTestQuery", tq):
            assert await alloc.reserve("kb-1", exclude_uuid="a1") == "FCOI-AUTO-Q001"
        assert tq.find_one.call_args.args[0]["uuid"] == {"$ne": "a1"}

    def test_allocator_never_repeats_within_a_batch(self):
        alloc = AutoQueryIdAllocator("KB", [])
        assert [alloc.allocate() for _ in range(3)] == ["KB-AUTO-Q001", "KB-AUTO-Q002", "KB-AUTO-Q003"]


class TestNotes:
    def test_names_date_sources_coverage_and_model(self):
        when = datetime.datetime(2026, 9, 9, 12, tzinfo=datetime.timezone.utc)
        text = auto_query_notes(
            source_names=["PAPPG Ch. 2", "PAPPG Ch. 2", "Award Letter"],
            coverage="standard", model_name="gpt-x", generated_at=when,
        )
        assert text == "Auto-generated 2026-09-09 from PAPPG Ch. 2, Award Letter (standard coverage, model gpt-x)."

    def test_omits_what_it_does_not_know(self):
        when = datetime.datetime(2026, 9, 9, tzinfo=datetime.timezone.utc)
        text = auto_query_notes(source_names=[], coverage="quick", model_name=None, generated_at=when)
        assert text == "Auto-generated 2026-09-09 (quick coverage)."


def _row(uuid, auto, external_id=None, created_at=None):
    row = SimpleNamespace(
        uuid=uuid, auto_generated=auto, external_id=external_id,
        created_at=created_at or datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    )
    row.save = AsyncMock()
    return row


def _patched_find(rows):
    find_call = MagicMock()
    find_call.to_list = AsyncMock(return_value=rows)
    tq = MagicMock()
    tq.find = MagicMock(return_value=find_call)
    tq.find_one = AsyncMock(return_value=None)  # reserve's re-check: nothing raced us
    return tq


@pytest.mark.asyncio
async def test_backfill_assigns_ids_oldest_first_and_leaves_imports_alone():
    t = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    imported = _row("i1", False, external_id="SUB-002")
    handwritten = _row("h1", False)
    newer = _row("a2", True, created_at=t + datetime.timedelta(days=1))
    older = _row("a1", True, created_at=t)
    already = _row("a0", True, external_id="FCOI-AUTO-Q001")
    kb = SimpleNamespace(uuid="kb-1", title="FCOI Knowledge Base")

    with patch("app.models.kb_test_query.KBTestQuery", _patched_find([imported, handwritten, newer, older, already])):
        updated = await backfill_auto_query_ids(kb)

    assert updated == 2
    assert older.external_id == "FCOI-AUTO-Q002"
    assert newer.external_id == "FCOI-AUTO-Q003"
    older.save.assert_awaited_once()
    newer.save.assert_awaited_once()
    assert imported.external_id == "SUB-002"
    assert handwritten.external_id is None
    handwritten.save.assert_not_called()
    already.save.assert_not_called()


@pytest.mark.asyncio
async def test_backfill_is_a_no_op_when_every_auto_query_has_an_id():
    rows = [_row("a0", True, external_id="KB-AUTO-Q001"), _row("h1", False)]
    with patch("app.models.kb_test_query.KBTestQuery", _patched_find(rows)):
        assert await backfill_auto_query_ids(SimpleNamespace(uuid="kb-1", title="X")) == 0
    for r in rows:
        r.save.assert_not_called()


def test_module_exposes_the_regex_the_ui_documents():
    assert ids.AUTO_ID_SUFFIX_RE.search("ECR-AUTO-Q042").group(1) == "042"
    assert ids.AUTO_ID_SUFFIX_RE.search("SUB-002") is None
