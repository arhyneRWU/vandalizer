"""Tests for pure helpers in app.services.document_readers.

The heavy readers (pymupdf, markitdown, formulas) are tested elsewhere via
integration; this file covers the deterministic cell-formatting, markdown
sanitation, and DOCX-extras helpers that have no external side effects.
"""

from __future__ import annotations

import datetime
import zipfile

import pytest

from app.services.document_readers import (
    _format_xlsx_cell,
    clean_markdown_nans,
    extract_docx_extras,
    pdf_has_ocrable_content,
    remove_images_from_markdown,
)


class TestCleanMarkdownNans:
    def test_strips_nan_cells_and_literal_nan_tokens(self):
        content = "| A | NaN |\n| NaN |\n| value | NaN |"
        # First line has a real value A, NaN gets blanked and kept
        # Second line has only NaN → empty row, dropped
        # Third has a value, kept
        result = clean_markdown_nans(content)
        assert "NaN" not in result
        assert "value" in result
        assert "| A |" in result

    def test_preserves_separator_rows(self):
        # Separator rows (--- in every cell) should survive even though
        # they don't contain "real" values.
        result = clean_markdown_nans("| --- | --- |")
        assert "---" in result

    def test_passes_through_non_table_lines_untouched(self):
        result = clean_markdown_nans("Intro paragraph\n\n## Header\n\nPlain text")
        assert "Intro paragraph" in result
        assert "## Header" in result
        assert "Plain text" in result

    def test_all_nan_row_strips_nan_tokens_but_keeps_line(self):
        # The filter's second branch (all cells "---" or empty) keeps
        # pipe-only rows even after NaN scrubbing.
        result = clean_markdown_nans("| NaN | NaN |")
        assert "NaN" not in result
        assert "|" in result


class TestRemoveImagesFromMarkdown:
    def test_inline_image_syntax_removed(self):
        md = "Before ![alt](http://example.com/pic.png) after"
        result = remove_images_from_markdown(md)
        assert "!" not in result
        assert "http://example.com/pic.png" not in result
        assert "Before" in result
        assert "after" in result

    def test_reference_style_image_removed(self):
        md = "Text ![alt][ref] more\n\n[ref]: http://x/y.png"
        result = remove_images_from_markdown(md)
        assert "![alt][ref]" not in result
        # The link reference definition is also scrubbed
        assert "[ref]:" not in result

    def test_attribute_blocks_removed(self):
        md = 'Heading {width="100" height="200"}'
        result = remove_images_from_markdown(md)
        assert "width=" not in result
        assert "height=" not in result

    def test_whitespace_and_blank_lines_collapsed(self):
        md = "Line 1\n\n\n\n\nLine 2"
        result = remove_images_from_markdown(md)
        # Three or more blank lines should collapse to two (one blank)
        assert "\n\n\n" not in result


class TestFormatXlsxCell:
    def test_none_becomes_empty_string(self):
        assert _format_xlsx_cell(None) == ""

    def test_bool_formatted_as_uppercase_words(self):
        assert _format_xlsx_cell(True) == "TRUE"
        assert _format_xlsx_cell(False) == "FALSE"

    def test_datetime_with_zero_time_renders_date_only(self):
        dt = datetime.datetime(2026, 1, 5, 0, 0, 0)
        assert _format_xlsx_cell(dt) == "2026-01-05"

    def test_datetime_with_time_renders_with_space_separator(self):
        dt = datetime.datetime(2026, 1, 5, 9, 30, 15)
        result = _format_xlsx_cell(dt)
        assert result.startswith("2026-01-05 09:30:15")

    def test_date_instance_uses_isoformat(self):
        assert _format_xlsx_cell(datetime.date(2026, 3, 5)) == "2026-03-05"

    def test_time_instance_uses_isoformat(self):
        assert _format_xlsx_cell(datetime.time(10, 15, 0)) == "10:15:00"

    def test_integer_float_renders_without_decimal(self):
        assert _format_xlsx_cell(42.0) == "42"

    def test_fractional_float_trims_trailing_zeros(self):
        assert _format_xlsx_cell(3.1400) == "3.14"

    def test_float_rounds_to_four_decimals(self):
        assert _format_xlsx_cell(1.23456789) == "1.2346"

    def test_zero_float_preserved(self):
        assert _format_xlsx_cell(0.0) == "0"

    def test_string_pipes_escaped(self):
        assert _format_xlsx_cell("a|b") == r"a\|b"

    def test_string_backslashes_doubled(self):
        # Backslash escaping runs first; pipes still get escaped after
        assert _format_xlsx_cell("a\\b|c") == r"a\\b\|c"

    def test_string_newlines_collapsed_to_spaces_and_trimmed(self):
        assert _format_xlsx_cell("  line1\nline2  ") == "line1 line2"


class TestExtractDocxExtras:
    def test_missing_file_returns_empty_string(self, tmp_path):
        missing = tmp_path / "does_not_exist.docx"
        assert extract_docx_extras(str(missing)) == ""

    def test_non_zip_file_returns_empty_string(self, tmp_path):
        junk = tmp_path / "not-a-docx.docx"
        junk.write_bytes(b"this is clearly not a zip")
        assert extract_docx_extras(str(junk)) == ""

    def test_empty_docx_without_comments_or_revisions_returns_empty(self, tmp_path):
        """A valid zip with no word/ entries yields no extras."""
        docx = tmp_path / "empty.docx"
        with zipfile.ZipFile(docx, "w") as zf:
            zf.writestr("[Content_Types].xml", "<x/>")
        assert extract_docx_extras(str(docx)) == ""

    def test_docx_with_comment_produces_markdown_section(self, tmp_path):
        """Build a minimal DOCX with one comment, confirm it surfaces."""
        ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        comments_xml = (
            f'<w:comments xmlns:w="{ns}">'
            f'  <w:comment w:author="Reviewer A" w:date="2026-03-01">'
            f'    <w:p><w:r><w:t>This needs revision.</w:t></w:r></w:p>'
            f'  </w:comment>'
            f'</w:comments>'
        )
        docx = tmp_path / "with_comments.docx"
        with zipfile.ZipFile(docx, "w") as zf:
            zf.writestr("word/comments.xml", comments_xml)

        out = extract_docx_extras(str(docx))
        assert "## Comments" in out
        assert "Reviewer A" in out
        assert "This needs revision" in out

    def test_malformed_comments_xml_swallowed_without_crash(self, tmp_path):
        """Invalid XML in word/comments.xml triggers the ParseError branch."""
        docx = tmp_path / "bad_xml.docx"
        with zipfile.ZipFile(docx, "w") as zf:
            zf.writestr("word/comments.xml", "<not valid xml")
        # Should return cleanly (possibly empty), not raise.
        extract_docx_extras(str(docx))

    def test_defusedxml_is_in_use(self):
        # Regression guard: the file's import line swap was the fix for
        # Bandit B314. If someone reverts it, this test flags it.
        import app.services.document_readers as dr
        source = dr.__loader__.get_source(dr.__name__) or ""
        assert "defusedxml.ElementTree" in source
        assert "import xml.etree.ElementTree as ET" not in source


def _save_pdf(doc, tmp_path, name: str) -> str:
    path = tmp_path / name
    doc.save(str(path))
    doc.close()
    return str(path)


class TestPdfHasOcrableContent:
    """Blank-page precheck: the OCR endpoint is a vision LLM that fabricates
    plausible text when handed a blank page, so PDFs must prove they have
    something to read before OCR runs. Rendering is the ground truth — a page
    that rasterizes to uniform white gives OCR nothing real to transcribe."""

    def test_blank_page_has_no_content(self, tmp_path):
        import pymupdf
        doc = pymupdf.open()
        doc.new_page()
        path = _save_pdf(doc, tmp_path, "blank.pdf")
        assert pdf_has_ocrable_content(path) is False

    def test_multiple_blank_pages_have_no_content(self, tmp_path):
        import pymupdf
        doc = pymupdf.open()
        for _ in range(3):
            doc.new_page()
        path = _save_pdf(doc, tmp_path, "blanks.pdf")
        assert pdf_has_ocrable_content(path) is False

    def test_text_layer_counts_as_content(self, tmp_path):
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Hello world")
        path = _save_pdf(doc, tmp_path, "text.pdf")
        assert pdf_has_ocrable_content(path) is True

    def test_embedded_image_counts_as_content(self, tmp_path):
        """A scanned page has no text layer but must still go to OCR."""
        import pymupdf
        img = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 10, 10))
        img.clear_with(0)  # solid black square
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_image(pymupdf.Rect(72, 72, 172, 172), pixmap=img)
        path = _save_pdf(doc, tmp_path, "scan.pdf")
        assert pdf_has_ocrable_content(path) is True

    def test_vector_ink_counts_as_content(self, tmp_path):
        """Outlined/vector text has no text layer and no images — it is only
        drawings. The raster pass must see its ink and let OCR run."""
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page()
        page.draw_rect(
            pymupdf.Rect(72, 72, 200, 100), color=(0, 0, 0), fill=(0, 0, 0)
        )
        path = _save_pdf(doc, tmp_path, "vector.pdf")
        assert pdf_has_ocrable_content(path) is True

    def test_white_background_rect_is_still_blank(self, tmp_path):
        """A decorative white rectangle is a drawing, but renders as blank
        paper — structurally non-empty, visually empty. Must not reach OCR."""
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page()
        page.draw_rect(
            pymupdf.Rect(0, 0, 612, 792), color=(1, 1, 1), fill=(1, 1, 1)
        )
        path = _save_pdf(doc, tmp_path, "white_rect.pdf")
        assert pdf_has_ocrable_content(path) is False

    def test_one_content_page_among_blanks_counts(self, tmp_path):
        import pymupdf
        doc = pymupdf.open()
        doc.new_page()
        page2 = doc.new_page()
        page2.insert_text((72, 72), "Only page 2 has text")
        path = _save_pdf(doc, tmp_path, "mixed.pdf")
        assert pdf_has_ocrable_content(path) is True

    def test_unreadable_file_fails_open(self, tmp_path):
        """A file PyMuPDF can't open must not be declared blank — OCR still
        gets its chance on odd-but-valid PDFs."""
        junk = tmp_path / "junk.pdf"
        junk.write_bytes(b"this is not a pdf")
        assert pdf_has_ocrable_content(str(junk)) is True


class TestBlankPdfSkipsOcr:
    """Blank PDFs must return empty text WITHOUT calling the OCR endpoint,
    so the empty-text guard in perform_extraction_and_update marks the
    document as an error instead of storing fabricated content."""

    def _blank_pdf(self, tmp_path) -> str:
        import pymupdf
        doc = pymupdf.open()
        doc.new_page()
        return _save_pdf(doc, tmp_path, "blank.pdf")

    def test_extract_text_with_markers_skips_ocr(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._blank_pdf(tmp_path)
        with patch.object(dr, "ocr_extract_text_from_pdf") as mock_ocr:
            text, markers = dr.extract_text_with_markers(path, "pdf")

        assert text == ""
        assert markers == []
        mock_ocr.assert_not_called()

    def test_extract_text_from_file_skips_ocr(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._blank_pdf(tmp_path)
        with patch.object(dr, "ocr_extract_text_from_pdf") as mock_ocr:
            result = dr.extract_text_from_file(path, "pdf")

        assert result == ""
        mock_ocr.assert_not_called()

    def test_pdf_with_text_still_reaches_ocr(self, tmp_path):
        """Regression guard: the precheck must not block normal PDFs."""
        from unittest.mock import patch
        import pymupdf
        import app.services.document_readers as dr

        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Real document text")
        path = _save_pdf(doc, tmp_path, "real.pdf")

        ocr_result = "x" * 200  # long enough to pass MIN_PDF_TEXT_LENGTH
        with patch.object(
            dr, "ocr_extract_text_from_pdf", return_value=ocr_result
        ) as mock_ocr:
            text, _ = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_called_once()
        assert text == ocr_result


class TestPdfInspectorFastPath:
    """A confidently text-based PDF should be extracted locally via
    pdf-inspector, skipping the OCR round-trip entirely. Anything scanned,
    low-confidence, or erroring must fall through to the existing OCR flow
    unchanged."""

    def _text_pdf(self, tmp_path, name="text.pdf") -> str:
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page()
        # Multi-line, multi-paragraph text laid out like a real document —
        # pdf-inspector's classifier is (correctly) less confident about a
        # single unwrapped line of raw insert_text than about normal
        # paragraph/line structure, so this needs real layout to clear the
        # module's confidence threshold, same as genuine uploads do.
        y = 72
        for para in range(4):
            page.insert_text((72, y), f"Paragraph {para + 1} heading", fontsize=13)
            y += 20
            for _ in range(3):
                page.insert_text(
                    (72, y),
                    "This is a real, digitally-native research document body line.",
                    fontsize=11,
                )
                y += 16
            y += 10
        return _save_pdf(doc, tmp_path, name)

    def test_confident_text_pdf_skips_ocr_via_markers(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path)
        with patch.object(dr, "ocr_extract_text_from_pdf") as mock_ocr:
            text, markers = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_not_called()
        assert "research document" in text
        assert markers == [{"char_offset": 0, "kind": "page", "value": 1}]

    def test_confident_text_pdf_skips_ocr_via_extract_text_from_file(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path)
        with patch.object(dr, "ocr_extract_text_from_pdf") as mock_ocr:
            result = dr.extract_text_from_file(path, "pdf")

        mock_ocr.assert_not_called()
        assert "research document" in result

    def test_scanned_classification_falls_through_to_ocr(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path, "looks_scanned.pdf")
        classification = type(
            "C", (), {"pdf_type": "scanned", "confidence": 0.95, "pages_needing_ocr": [1]},
        )()
        ocr_result = "x" * 200
        with patch("pdf_inspector.classify_pdf", return_value=classification), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=ocr_result) as mock_ocr:
            text, _ = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_called_once()
        assert text == ocr_result

    def test_low_confidence_falls_through_to_ocr(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path)
        classification = type(
            "C", (), {"pdf_type": "text_based", "confidence": 0.5, "pages_needing_ocr": []},
        )()
        ocr_result = "x" * 200
        with patch("pdf_inspector.classify_pdf", return_value=classification), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=ocr_result) as mock_ocr:
            text, _ = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_called_once()
        assert text == ocr_result

    def test_pages_needing_ocr_falls_through(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path)
        classification = type(
            "C", (), {"pdf_type": "text_based", "confidence": 0.99, "pages_needing_ocr": [0]},
        )()
        ocr_result = "x" * 200
        with patch("pdf_inspector.classify_pdf", return_value=classification), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=ocr_result) as mock_ocr:
            text, _ = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_called_once()
        assert text == ocr_result

    def test_extraction_error_falls_through_to_ocr(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path)
        classification = type(
            "C", (), {"pdf_type": "text_based", "confidence": 0.99, "pages_needing_ocr": []},
        )()
        ocr_result = "x" * 200
        with patch("pdf_inspector.classify_pdf", return_value=classification), \
             patch("pdf_inspector.extract_pages_markdown", side_effect=RuntimeError("boom")), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=ocr_result) as mock_ocr:
            text, _ = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_called_once()
        assert text == ocr_result

    def test_short_extracted_markdown_falls_through_to_ocr(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        path = self._text_pdf(tmp_path)
        classification = type(
            "C", (), {"pdf_type": "text_based", "confidence": 0.99, "pages_needing_ocr": []},
        )()
        page_result = type("Page", (), {"page": 0, "markdown": "too short"})()
        extraction = type(
            "E", (), {"pages": [page_result], "pages_with_tables": []},
        )()
        ocr_result = "x" * 200
        with patch("pdf_inspector.classify_pdf", return_value=classification), \
             patch("pdf_inspector.extract_pages_markdown", return_value=extraction), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=ocr_result) as mock_ocr:
            text, _ = dr.extract_text_with_markers(path, "pdf")

        mock_ocr.assert_called_once()
        assert text == ocr_result


class TestPageMarkerProvenance:
    """Interpolated and real page markers are the same shape, so nothing
    downstream could tell an estimated page boundary from a measured one.
    Consumers that cite pages need to know which they are holding."""

    def test_interpolated_markers_are_flagged_approximate(self):
        from app.services.document_readers import _interpolate_page_markers

        markers = _interpolate_page_markers("x" * 100, 4)

        assert len(markers) == 4
        assert all(m["approximate"] is True for m in markers)

    def test_real_page_markers_are_not_flagged(self, tmp_path):
        """Regression guard rather than a red-green test: measured boundaries
        must never acquire the flag, or every citation becomes hedged."""
        import pymupdf

        from app.services.document_readers import _pymupdf_extract_with_pages

        doc = pymupdf.open()
        for line in ("Page one body text", "Page two body text"):
            doc.new_page().insert_text((72, 72), line)
        path = _save_pdf(doc, tmp_path, "two_pages.pdf")

        _, markers = _pymupdf_extract_with_pages(path)

        assert [m["value"] for m in markers] == [1, 2]
        assert not any(m.get("approximate") for m in markers)


class TestPageSeparatorsInOcrText:
    """Some OCR services already mark page breaks with a form feed — it is the
    long-standing convention for paginated plain text (Tesseract and pdftotext
    both emit it). Vandalizer's ``raw`` contract makes the response body *be*
    the text, so there is no field for a page number, and that separator is the
    only page structure such a response carries. Interpolating over it throws
    away boundaries we were handed.

    Every case here is gated on agreeing with the PDF's own page count: a
    split that disagrees is not trustworthy, and confidently wrong page numbers
    are worse than admittedly estimated ones."""

    def test_form_feed_split_matching_page_count_is_measured(self):
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("alpha\fbeta\fgamma", 3)

        assert result is not None
        text, markers = result
        assert [m["value"] for m in markers] == [1, 2, 3]
        assert not any(m.get("approximate") for m in markers)
        # Offsets must index the returned text, not the original.
        assert all(
            text[marker["char_offset"]:].startswith(expected)
            for marker, expected in zip(markers, ["alpha", "beta", "gamma"])
        )

    def test_trailing_form_feed_still_matches(self):
        """Tesseract terminates every page, so the last split is empty."""
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("one\ftwo\f", 2)

        assert result is not None
        _, markers = result
        assert [m["value"] for m in markers] == [1, 2]

    def test_blank_middle_page_is_kept(self):
        """A page that OCR'd to nothing is still a page — dropping it would
        shift every later page number by one."""
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("one\f\fthree\f", 3)

        assert result is not None
        _, markers = result
        assert [m["value"] for m in markers] == [1, 2, 3]

    def test_count_mismatch_is_rejected(self):
        from app.services.document_readers import _measured_page_markers_from_text

        assert _measured_page_markers_from_text("one\ftwo", 5) is None

    def test_no_separator_in_multipage_text_is_rejected(self):
        from app.services.document_readers import _measured_page_markers_from_text

        assert _measured_page_markers_from_text("no separators here", 4) is None

    def test_single_page_needs_no_separator(self):
        """One page is trivially exact — the text starts at offset 0."""
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("only page", 1)

        assert result is not None
        text, markers = result
        assert text == "only page"
        assert markers == [{"char_offset": 0, "kind": "page", "value": 1}]

    def test_a_stray_separator_inside_a_page_is_rejected(self):
        """The failure this gate exists for.

        A form feed that is part of a page's own content, rather than a page
        break, yields one segment too many. Believing it would shift every page
        after it by one — silently, and only on the documents unlucky enough to
        contain the character.
        """
        from app.services.document_readers import _measured_page_markers_from_text

        assert _measured_page_markers_from_text("one\fstray\ftwo", 2) is None

    def test_a_coincidental_match_is_the_known_limit(self):
        """Honest about what the count check cannot do.

        Two stray separators in a document whose real breaks were dropped can
        add up to the right total, and this accepts it. The check is a cheap
        guard against the common case, not a proof of correctness — which is
        why the page-aware contract (a JSON page array) is the durable fix and
        this is the opportunistic one.
        """
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("a\fb\fc", 3)

        assert result is not None  # accepted, and possibly wrong

    def test_windows_line_endings_around_the_separator(self):
        """OCR services that emit CRLF must not defeat the trailing-page trim."""
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("one\r\n\ftwo\r\n\f", 2)

        assert result is not None
        _, markers = result
        assert [m["value"] for m in markers] == [1, 2]

    def test_zero_pages_is_rejected(self):
        from app.services.document_readers import _measured_page_markers_from_text

        assert _measured_page_markers_from_text("text", 0) is None

    def test_empty_text_is_rejected(self):
        from app.services.document_readers import _measured_page_markers_from_text

        assert _measured_page_markers_from_text("", 3) is None

    def test_offsets_index_the_returned_text_not_the_original(self):
        """Removing the separators shifts every offset after the first. A marker
        computed against the pre-strip string would drift one character per
        page — invisible on page 1, wrong by the end of a long document."""
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("aaa\fbbb\fccc", 3)

        assert result is not None
        text, markers = result
        assert [text[m["char_offset"]] for m in markers] == ["a", "b", "c"]

    def test_separators_are_removed_from_the_text(self):
        """The form feed is a control character, not content. Leaving it in
        would place it right where ``annotate_pages`` inserts ``[p. N]``."""
        from app.services.document_readers import _measured_page_markers_from_text

        result = _measured_page_markers_from_text("one\ftwo", 2)

        assert result is not None
        text, _ = result
        assert "\f" not in text


class TestExtractWithMarkersUsesPageSeparators:
    """End to end through the OCR branch: a page-aware OCR response must
    produce measured markers, and anything else must still interpolate."""

    def test_ocr_with_form_feeds_yields_measured_markers(self):
        from unittest.mock import patch
        import app.services.document_readers as dr

        body = ("Page one text, long enough to clear the acceptance gate. " * 3
                + "\f"
                + "Page two text, also long enough to clear the gate. " * 3)

        with patch.object(dr, "pdf_has_ocrable_content", return_value=True), \
             patch.object(dr, "_local_markdown_extract_from_pdf", return_value=None), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=body), \
             patch.object(dr, "pdf_page_count", return_value=2):
            text, markers = dr.extract_text_with_markers("scan.pdf", "pdf")

        assert [m["value"] for m in markers] == [1, 2]
        assert not any(m.get("approximate") for m in markers), \
            "boundaries came from the OCR response, so they must not be hedged"
        assert text.startswith("Page one text")
        assert "\f" not in text

    def test_ocr_without_separators_still_interpolates(self):
        """Regression guard: the common case must be untouched."""
        from unittest.mock import patch
        import app.services.document_readers as dr

        body = "Flat OCR text with no page structure at all. " * 8

        with patch.object(dr, "pdf_has_ocrable_content", return_value=True), \
             patch.object(dr, "_local_markdown_extract_from_pdf", return_value=None), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=body), \
             patch.object(dr, "pdf_page_count", return_value=4):
            text, markers = dr.extract_text_with_markers("scan.pdf", "pdf")

        assert [m["value"] for m in markers] == [1, 2, 3, 4]
        assert all(m["approximate"] is True for m in markers)
        assert text == body

    def test_ocr_with_untrustworthy_split_interpolates(self):
        """Three form-feed segments in a five-page PDF: the separator is there
        but does not describe this document, so it must not be believed."""
        from unittest.mock import patch
        import app.services.document_readers as dr

        body = "Alpha section. " * 8 + "\f" + "Beta section. " * 8 + "\f" + "Gamma. " * 8

        with patch.object(dr, "pdf_has_ocrable_content", return_value=True), \
             patch.object(dr, "_local_markdown_extract_from_pdf", return_value=None), \
             patch.object(dr, "ocr_extract_text_from_pdf", return_value=body), \
             patch.object(dr, "pdf_page_count", return_value=5):
            _, markers = dr.extract_text_with_markers("scan.pdf", "pdf")

        assert len(markers) == 5
        assert all(m["approximate"] is True for m in markers)


class TestExtractWithMarkersOcrFallback:
    """When OCR returns short-but-valid text and the PyMuPDF page-boundary
    refinement fails (corrupt PDF, or the source file removed mid-processing),
    the OCR text must be used rather than crashing the extraction task."""

    def test_pymupdf_failure_uses_ocr_text(self):
        from unittest.mock import patch
        import app.services.document_readers as dr

        with patch.object(dr, "ocr_extract_text_from_pdf", return_value="short ocr text"), \
             patch.object(dr, "_pymupdf_extract_with_pages",
                          side_effect=FileNotFoundError("no such file: 'gone.pdf'")), \
             patch.object(dr, "pdf_page_count", return_value=1):
            text, markers = dr.extract_text_with_markers("gone.pdf", "pdf")

        assert text == "short ocr text"
        assert isinstance(markers, list)

    def test_pymupdf_failure_reraises_without_ocr_text(self):
        from unittest.mock import patch
        import app.services.document_readers as dr

        with patch.object(dr, "ocr_extract_text_from_pdf", return_value=""), \
             patch.object(dr, "_pymupdf_extract_with_pages",
                          side_effect=FileNotFoundError("no such file: 'gone.pdf'")):
            with pytest.raises(FileNotFoundError):
                dr.extract_text_with_markers("gone.pdf", "pdf")

    def test_extract_text_from_file_pymupdf_failure_uses_ocr_text(self):
        from unittest.mock import patch
        import app.services.document_readers as dr

        with patch.object(dr, "ocr_extract_text_from_pdf", return_value="short ocr text"), \
             patch.object(dr, "extract_text_from_pdf",
                          side_effect=FileNotFoundError("no such file: 'gone.pdf'")):
            assert dr.extract_text_from_file("gone.pdf", "pdf") == "short ocr text"

class TestExtractTextFromFileMissingFile:
    """A missing source file (deleted mid-processing / stale path) is benign:
    return empty text and log at warning, never error -> Sentry, and never a
    "[Error extracting content: ...]" placeholder that masquerades as content."""

    def test_missing_txt_returns_empty_and_warns(self, tmp_path):
        from unittest.mock import patch
        import app.services.document_readers as dr

        gone = str(tmp_path / "nope" / "8D112.txt")  # nonexistent
        with patch.object(dr, "logger") as mock_logger:
            result = dr.extract_text_from_file(gone, "txt")

        assert result == ""
        assert "[Error extracting content" not in result
        mock_logger.error.assert_not_called()
        mock_logger.warning.assert_called()
