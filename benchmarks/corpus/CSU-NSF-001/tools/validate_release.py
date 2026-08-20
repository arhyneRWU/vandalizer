#!/usr/bin/env python3
"""Validate structural invariants for the CSU-NSF-001 benchmark release.

The keys live in the tree and the documents live on a release, so the checks
split the same way. Everything that reads only the keys — question parity
between JSON and CSV, version agreement, the budget total, and the structural
rules the corroborating sets must obey — runs with `--keys` alone, which is
what a pull-request job can do. Give it `--binaries` as well and the page
bounds are checked against PDFs actually opened rather than against the
expected page counts recorded here, and the reference-citation cross-check
runs over the extracted narrative.

Run: uv run --with pypdf --with python-docx python \\
       benchmarks/corpus/CSU-NSF-001/tools/validate_release.py \\
       --keys benchmarks/corpus/CSU-NSF-001 [--binaries DIR]
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


EXPECTED_PDFS = {
    "01_CSU_Synthetic_FA_Rate_Agreement.pdf": 2,
    "02_CSU_Synthetic_Budget_Policy.pdf": 3,
    "03_Project_Summary.pdf": 1,
    "04_Project_Description.pdf": 13,
    "05_Budget_Justification.pdf": 3,
    "06_Data_Management_Plan.pdf": 2,
    "07_References_Cited.pdf": 3,
    "08_Facilities_Equipment_Resources.pdf": 2,
    "09_Postdoc_Mentoring_Plan.pdf": 1,
    "10_Biographical_Sketches.pdf": 4,
    "11_Current_Pending_Support.pdf": 2,
}

WORKBOOK = "CSU_NSF_001_Budget.xlsx"


def fail(message: str, failures: list[str]) -> None:
    failures.append(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keys", type=Path, required=True,
                        help="directory holding ground_truth.json, manifest.json, "
                             "benchmark_questions.csv")
    parser.add_argument("--binaries", type=Path,
                        help="directory holding the unpacked release assets "
                             "(pdf/, source/); omit for key-only checks")
    args = parser.parse_args()
    keys = args.keys
    binaries = args.binaries
    failures: list[str] = []

    ground_truth = json.loads((keys / "ground_truth.json").read_text())
    manifest = json.loads((keys / "manifest.json").read_text())
    with (keys / "benchmark_questions.csv").open(newline="", encoding="utf-8") as handle:
        csv_questions = list(csv.DictReader(handle))

    questions = ground_truth["questions"]
    if len(questions) != 30:
        fail(f"expected 30 ground-truth questions, found {len(questions)}", failures)
    if len(csv_questions) != 30:
        fail(f"expected 30 CSV questions, found {len(csv_questions)}", failures)

    json_by_id = {question["id"]: question for question in questions}
    csv_by_id = {question["id"]: question for question in csv_questions}
    if set(json_by_id) != set(csv_by_id):
        fail("ground_truth.json and benchmark_questions.csv question IDs differ", failures)
    for question_id in sorted(set(json_by_id) & set(csv_by_id)):
        json_question = json_by_id[question_id]
        csv_question = csv_by_id[question_id]
        for field in ("difficulty", "type", "question"):
            if str(json_question[field]) != csv_question[field]:
                fail(f"{question_id}: field '{field}' differs between JSON and CSV", failures)
        if str(bool(json_question["answerable"])) != csv_question["answerable"]:
            fail(f"{question_id}: answerable differs between JSON and CSV", failures)

    # With the binaries, page bounds are checked against the documents as they
    # actually are; without them, against the counts recorded above. The second
    # is weaker — it cannot notice a re-layout — which is why the asset job
    # exists at all.
    if binaries is None:
        page_counts = dict(EXPECTED_PDFS)
    else:
        page_counts = {}
        for filename, expected_pages in EXPECTED_PDFS.items():
            path = binaries / "pdf" / filename
            if not path.exists():
                fail(f"missing PDF: {filename}", failures)
                continue
            actual_pages = len(PdfReader(path).pages)
            page_counts[filename] = actual_pages
            if actual_pages != expected_pages:
                fail(f"{filename}: expected {expected_pages} pages, found {actual_pages}", failures)

    def workbook_missing(filename: str) -> bool:
        """Only the asset job can see the workbook; the tree job takes it on trust."""
        return binaries is not None and not (binaries / "source" / filename).exists()

    for question in questions:
        for source in question.get("sources", []):
            filename, page_number = source[0], source[1]
            if filename.endswith(".xlsx"):
                if workbook_missing(filename):
                    fail(f"{question['id']}: missing source workbook {filename}", failures)
                if page_number is not None:
                    fail(f"{question['id']}: workbook source must not have a page number", failures)
                continue
            if filename not in page_counts:
                fail(f"{question['id']}: unknown source document {filename}", failures)
            elif not isinstance(page_number, int):
                fail(f"{question['id']}: {filename} page must be an integer, "
                     f"found {page_number!r}", failures)
            elif not 1 <= page_number <= page_counts[filename]:
                fail(
                    f"{question['id']}: page {page_number} outside {filename} "
                    f"(1-{page_counts[filename]})",
                    failures,
                )

    for question in questions:
        corroborating = question.get("corroborating_sources")
        if corroborating is None:
            fail(f"{question['id']}: missing corroborating_sources", failures)
            continue
        if not question.get("answerable", True) and corroborating:
            fail(f"{question['id']}: unanswerable question has corroborating_sources", failures)
        canonical = {(s[0], s[1]) for s in question.get("sources", [])}
        for source in corroborating:
            filename, page_number = source[0], source[1]
            if (filename, page_number) in canonical:
                fail(f"{question['id']}: corroborating source duplicates sources: "
                     f"{filename} p.{page_number}", failures)
            if filename.endswith(".xlsx"):
                if workbook_missing(filename):
                    fail(f"{question['id']}: missing corroborating workbook {filename}", failures)
                if page_number is not None:
                    fail(f"{question['id']}: workbook corroborating source must not have a page",
                         failures)
                continue
            if filename not in page_counts:
                fail(f"{question['id']}: unknown corroborating document {filename}", failures)
            elif not isinstance(page_number, int):
                fail(f"{question['id']}: corroborating {filename} page must be an integer, "
                     f"found {page_number!r}", failures)
            elif not 1 <= page_number <= page_counts[filename]:
                fail(f"{question['id']}: corroborating page {page_number} outside {filename}",
                     failures)

    if binaries is not None:
        project_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(binaries / "pdf" / "04_Project_Description.pdf").pages
        )
        references_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(binaries / "pdf" / "07_References_Cited.pdf").pages
        )
        cited: set[int] = set()
        for bracket in re.findall(r"\[([0-9,\-\s]+)\]", project_text):
            for part in bracket.split(","):
                part = part.strip()
                if "-" in part:
                    start, end = (int(value) for value in part.split("-", 1))
                    cited.update(range(start, end + 1))
                elif part:
                    cited.add(int(part))
        listed = {int(value) for value in re.findall(r"(?m)^\s*\[(\d+)\]", references_text)}
        expected_references = set(range(1, 25))
        if cited != expected_references:
            fail(f"Project Description citation set is {sorted(cited)}, expected 1-24", failures)
        if listed != expected_references:
            fail(f"References Cited set is {sorted(listed)}, expected 1-24", failures)

    system_inputs = set(manifest["system_input_files"])
    expected_inputs = set(EXPECTED_PDFS) | {WORKBOOK}
    if system_inputs != expected_inputs:
        fail("manifest system_input_files does not match release inputs", failures)
    if manifest.get("version") != ground_truth.get("version"):
        fail("manifest and ground-truth versions differ", failures)
    if ground_truth.get("display_budget_total") != 1169898.51:
        fail("display budget total changed", failures)

    if failures:
        print("RELEASE VALIDATION: FAIL")
        for message in failures:
            print(f"- {message}")
        sys.exit(1)

    if binaries is None:
        print(
            f"RELEASE VALIDATION: PASS (keys only; {len(questions)} questions, "
            f"pages bounded by EXPECTED_PDFS, reference cross-check skipped)"
        )
    else:
        print(
            f"RELEASE VALIDATION: PASS (keys and binaries; {len(questions)} questions, "
            f"{sum(page_counts.values())} PDF pages, 24 references)"
        )


if __name__ == "__main__":
    main()
