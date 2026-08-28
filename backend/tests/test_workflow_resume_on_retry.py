"""A retried workflow resumes; it does not re-execute what already succeeded.

`execute_workflow_task` carries `autoretry_for=TRANSIENT_EXCEPTIONS,
max_retries=3` and had no resume index, so a provider read timeout on step 4
restarted the whole workflow from step 0 — up to three more times. An
`APICallNode` POST on step 2 fired four times, a `save_to_folder` wrote four
copies, and the tokens for every earlier step were billed four times over.

The engine has supported resuming since the approval gate was built
(`start_index` / `initial_output`). These tests cover the decision of *where*
to pick up, which is the part that can be wrong in a way nobody notices until
a side effect has already fired twice.
"""

from unittest.mock import MagicMock

from app.tasks.workflow_tasks import _resume_point


def _engine(keys: list[str]) -> MagicMock:
    engine = MagicMock()
    engine.step_output_keys.return_value = keys
    return engine


KEYS = ["Document", "Extract", "Call API", "Format"]


class TestResumePoint:
    def test_resumes_after_the_last_completed_step(self):
        """num_steps_completed is the index of the step that finished, so the
        next pass starts one past it and is fed that step's output."""
        start, initial = _resume_point(
            _engine(KEYS),
            {
                "num_steps_completed": 1,
                "steps_output": {"Extract": {"output": "extracted", "step_name": "Extraction"}},
            },
        )
        assert start == 2
        assert initial == {"output": "extracted", "step_name": "Extraction"}

    def test_no_completed_steps_means_a_full_rerun(self):
        assert _resume_point(_engine(KEYS), {}) == (0, None)
        assert _resume_point(
            _engine(KEYS), {"num_steps_completed": 0, "steps_output": {}},
        ) == (0, None)

    def test_a_missing_output_for_the_last_step_means_a_full_rerun(self):
        """Resuming without the input the next step needs would feed it None
        and produce a confidently empty run."""
        assert _resume_point(
            _engine(KEYS),
            {"num_steps_completed": 2, "steps_output": {"Extract": {"output": "x"}}},
        ) == (0, None)

    def test_a_non_dict_output_means_a_full_rerun(self):
        assert _resume_point(
            _engine(KEYS),
            {"num_steps_completed": 1, "steps_output": {"Extract": "just a string"}},
        ) == (0, None)

    def test_a_workflow_edited_between_attempts_starts_over(self):
        """Replaying old outputs against a re-shaped graph would attribute them
        to different steps."""
        assert _resume_point(
            _engine(["Document", "Extract"]),
            {"num_steps_completed": 3, "steps_output": {"Format": {"output": "x"}}},
        ) == (0, None)

    def test_the_last_step_can_be_the_resume_point(self):
        start, initial = _resume_point(
            _engine(KEYS),
            {"num_steps_completed": 3, "steps_output": {"Format": {"output": "done"}}},
        )
        assert start == 4
        assert initial == {"output": "done"}

    def test_a_missing_count_is_treated_as_none_completed(self):
        assert _resume_point(
            _engine(KEYS), {"steps_output": {"Extract": {"output": "x"}}},
        ) == (0, None)
