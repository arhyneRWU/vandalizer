"""The JSON-fallback path must not turn a key mismatch into "not found".

``two_pass.pass_1.structured`` is False by default, so the fallback parser is
the default first pass. It used to project the payload onto the requested keys
with an exact ``parsed.get(key)``, so a model answering "Award Amount" for the
requested key "Award amount" produced an entity of all-nulls — recorded,
displayed and exported as a confident set of "not in the document" answers.
"""

import pytest

from app.services.extraction_engine import ExtractionEngine, ExtractionError


class _Result:
    def __init__(self, output):
        self.output = output

    def usage(self):  # pragma: no cover - not asserted on
        raise AttributeError


class _Agent:
    def __init__(self, output):
        self._output = output

    def run_sync(self, _prompt):
        return _Result(self._output)


@pytest.fixture
def engine():
    return ExtractionEngine(system_config_doc={})


def _run(monkeypatch, engine, payload, keys, capture_sources=False):
    monkeypatch.setattr(
        "app.services.extraction_engine.create_chat_agent",
        lambda *a, **k: _Agent(payload),
    )
    return engine._extract_fallback_json(
        "some document text", keys, "test-model", capture_sources=capture_sources,
    )


KEYS = ["Award amount", "PI Name", "2 CFR Part 200"]


def test_case_and_punctuation_drift_still_resolves(monkeypatch, engine):
    payload = '{"Award Amount": "$500,000", "pi_name": "Jane Smith", "2 CFR part 200": "Yes"}'
    (entity,) = _run(monkeypatch, engine, payload, KEYS)
    assert entity == {
        "Award amount": "$500,000",
        "PI Name": "Jane Smith",
        "2 CFR Part 200": "Yes",
    }


def test_exact_keys_are_preferred_over_folded_collisions(monkeypatch, engine):
    payload = '{"Award amount": "exact", "AWARDAMOUNT": "folded"}'
    (entity,) = _run(monkeypatch, engine, payload, ["Award amount"])
    assert entity["Award amount"] == "exact"


def test_genuinely_absent_fields_stay_null_without_raising(monkeypatch, engine):
    payload = '{"Award amount": null, "PI Name": null, "2 CFR Part 200": null}'
    (entity,) = _run(monkeypatch, engine, payload, KEYS)
    assert entity == {"Award amount": None, "PI Name": None, "2 CFR Part 200": None}


def test_zero_matching_keys_fails_the_run(monkeypatch, engine):
    payload = '{"totally": "unrelated", "other": "keys"}'
    with pytest.raises(ExtractionError, match="none of the requested fields"):
        _run(monkeypatch, engine, payload, KEYS)


def test_empty_object_fails_the_run(monkeypatch, engine):
    with pytest.raises(ExtractionError, match="none of the requested fields"):
        _run(monkeypatch, engine, "{}", KEYS)


def test_sources_block_survives_key_drift(monkeypatch, engine):
    payload = (
        '{"Award Amount": "$500,000", '
        '"_sources": {"award amount": "The total award is $500,000."}}'
    )
    (entity,) = _run(
        monkeypatch, engine, payload, ["Award amount"], capture_sources=True,
    )
    sidecar = entity["_field_sources"]
    assert sidecar["Award amount"]["quote"] == "The total award is $500,000."


def test_list_payload_is_remapped_and_keeps_extra_keys(monkeypatch, engine):
    payload = '[{"Award Amount": "$1", "extra": "kept"}, {"Award Amount": "$2"}]'
    entities = _run(monkeypatch, engine, payload, ["Award amount"])
    assert [e["Award amount"] for e in entities] == ["$1", "$2"]
    assert entities[0]["extra"] == "kept"


def test_list_payload_with_no_matching_keys_fails_the_run(monkeypatch, engine):
    with pytest.raises(ExtractionError, match="none of the requested fields"):
        _run(monkeypatch, engine, '[{"nope": 1}]', KEYS)
