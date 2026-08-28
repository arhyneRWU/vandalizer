"""Workflow and automation extractions carry provenance.

`workflow_engine.data_extraction_model` used to call `engine.extract` with
neither `capture_sources` nor `doc_metadata`, so every value produced by a
workflow step — and therefore by the overnight folder-watch automation, the
highest-volume and least-supervised path in the product — arrived with no
quote, no page and no verification. "Source-linked answers" was an
interactive-UI feature the batch layer did not have.

The engine pairs `doc_metadata` with `doc_texts` *by position*, so these tests
lean hardest on alignment: a metadata list that drifts by one entry attributes
every quote to the wrong document.
"""

from unittest.mock import MagicMock, patch

from app.services.extraction_sources import SOURCE_KEY
from app.services.form_fill import DOC_META_TASKS
from app.services.workflow_engine import (
    ExtractionNode,
    data_extraction_model,
    format_extraction_results,
)


def _node(data: dict) -> ExtractionNode:
    return ExtractionNode({"model": "gpt-4o", **data})


class TestExtractionNodeRequestsSources:
    @patch("app.services.workflow_engine.data_extraction_model")
    def test_capture_sources_is_always_on(self, mock_extract):
        mock_extract.return_value = {"raw": [], "formatted": ""}
        _node({"keys": ["X"]}).process({"output": "prev text", "step_name": "Prompt"})
        assert mock_extract.call_args.kwargs["capture_sources"] is True

    @patch("app.services.workflow_engine.data_extraction_model")
    def test_workflow_documents_metadata_is_index_aligned(self, mock_extract):
        mock_extract.return_value = {"raw": [], "formatted": ""}
        _node({
            "keys": ["X"],
            "input_source": "workflow_documents",
            "doc_texts": ["first doc", "second doc"],
            "doc_metas": [
                {"uuid": "u1", "title": "First", "text_markers": [{"page": 1}]},
                {"uuid": "u2", "title": "Second", "text_markers": [{"page": 1}]},
            ],
        }).process({"output": "prev", "step_name": "SomeStep"})

        kwargs = mock_extract.call_args.kwargs
        assert kwargs["doc_texts"] == ["first doc", "second doc"]
        assert [m["uuid"] for m in kwargs["doc_metadata"]] == ["u1", "u2"]
        assert kwargs["doc_metadata"][1]["title"] == "Second"

    @patch("app.services.workflow_engine.data_extraction_model")
    def test_blank_document_text_does_not_shift_metadata(self, mock_extract):
        """A doc that yielded no text is skipped in the texts list, so its
        metadata must be skipped with it — otherwise every later quote is
        attributed one document too early."""
        mock_extract.return_value = {"raw": [], "formatted": ""}
        _node({
            "keys": ["X"],
            "input_source": "workflow_documents",
            "doc_texts": ["", "second doc"],
            "doc_metas": [{"uuid": "u1"}, {"uuid": "u2"}],
        }).process({"output": "prev", "step_name": "SomeStep"})

        kwargs = mock_extract.call_args.kwargs
        assert kwargs["doc_texts"] == ["second doc"]
        assert [m["uuid"] for m in kwargs["doc_metadata"]] == ["u2"]

    @patch("app.services.workflow_engine.data_extraction_model")
    def test_selected_document_carries_its_metadata(self, mock_extract):
        mock_extract.return_value = {"raw": [], "formatted": ""}
        _node({
            "keys": ["Name"],
            "input_source": "select_document",
            "selected_doc_text": "Bob is a scientist.",
            "selected_doc_meta": {"uuid": "sel", "title": "Bio", "text_markers": [{"page": 3}]},
        }).process({"output": "prev", "step_name": "Prompt"})

        kwargs = mock_extract.call_args.kwargs
        assert kwargs["full_text"] == "Bob is a scientist."
        assert kwargs["doc_metadata"] == [
            {"uuid": "sel", "title": "Bio", "text_markers": [{"page": 3}]}
        ]

    @patch("app.services.workflow_engine.data_extraction_model")
    def test_mixed_sources_stay_aligned(self, mock_extract):
        """A previous step's output has no document behind it, but it still
        occupies a slot so the documents after it keep their own."""
        mock_extract.return_value = {"raw": [], "formatted": ""}
        _node({
            "keys": ["X"],
            "input_sources": ["step_input", "workflow_documents"],
            "doc_texts": ["doc one"],
            "doc_metas": [{"uuid": "u1", "title": "One", "text_markers": []}],
        }).process({"output": "previous step output", "step_name": "Prompt"})

        kwargs = mock_extract.call_args.kwargs
        assert kwargs["doc_texts"] == ["previous step output", "doc one"]
        metas = kwargs["doc_metadata"]
        assert len(metas) == 2
        assert metas[0] == {"uuid": None, "title": None, "text_markers": []}
        assert metas[1]["uuid"] == "u1"

    @patch("app.services.workflow_engine.data_extraction_model")
    def test_missing_metadata_still_produces_aligned_placeholders(self, mock_extract):
        """An older run (or a hydration path that never attached doc_metas)
        must still extract — the quotes simply resolve to no page."""
        mock_extract.return_value = {"raw": [], "formatted": ""}
        _node({
            "keys": ["X"],
            "input_source": "workflow_documents",
            "doc_texts": ["a", "b"],
        }).process({"output": "prev", "step_name": "SomeStep"})

        metas = mock_extract.call_args.kwargs["doc_metadata"]
        assert len(metas) == 2
        assert all(m == {"uuid": None, "title": None, "text_markers": []} for m in metas)


class TestDataExtractionModelForwards:
    @patch("app.services.workflow_engine.ExtractionEngine")
    def test_sources_reach_the_engine(self, mock_engine_cls):
        engine = MagicMock()
        engine.extract.return_value = []
        engine.tokens_in = engine.tokens_out = 0
        mock_engine_cls.return_value = engine

        meta = [{"uuid": "u1", "title": "One", "text_markers": []}]
        data_extraction_model(
            "gpt-4o", ["X"], doc_texts=["text"],
            capture_sources=True, doc_metadata=meta,
        )

        kwargs = engine.extract.call_args.kwargs
        assert kwargs["capture_sources"] is True
        assert kwargs["doc_metadata"] == meta


class TestFormattedOutput:
    def test_source_sidecar_is_not_rendered_as_a_field(self):
        """The sidecar is provenance, not an extracted value — dumping it into
        the step's markdown would put a wall of JSON in the deliverable."""
        formatted = format_extraction_results([{
            "Award Amount": "$4,200,000",
            SOURCE_KEY: {"Award Amount": {"quote": "The award is $4,200,000.", "page": 12}},
        }])
        assert "**Award Amount**: $4,200,000" in formatted
        assert SOURCE_KEY not in formatted
        assert "quote" not in formatted


class TestHydration:
    def test_extraction_tasks_get_document_metadata(self):
        assert "Extraction" in DOC_META_TASKS
        assert "FormFiller" in DOC_META_TASKS

    def test_build_steps_data_attaches_doc_metas_to_extraction(self):
        from app.tasks.workflow_tasks import _build_steps_data

        db = MagicMock()
        db.workflow_step.find_one.return_value = {
            "_id": "s1", "name": "Extract", "tasks": ["t1"],
        }
        db.workflow_step_task.find_one.return_value = {
            "_id": "t1", "name": "Extraction", "data": {"keys": ["X"]},
        }
        db.smart_document.find_one.return_value = {
            "uuid": "d1", "title": "Proposal", "raw_text": "body",
            "text_markers": [{"page": 1, "char_offset": 0}],
        }

        steps_data, _ = _build_steps_data(
            db, {"steps": ["s1"], "input_config": {}}, "wf1", {"doc_uuids": ["d1"]},
        )

        task_data = steps_data[1]["tasks"][0]["data"]
        assert task_data["doc_texts"] == ["body"]
        assert task_data["doc_metas"] == [{
            "uuid": "d1", "title": "Proposal",
            "text_markers": [{"page": 1, "char_offset": 0}],
        }]
