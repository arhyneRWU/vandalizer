"""Tests for the orphaned-workflow cleanup script's decision rule.

The script itself needs a live MongoDB, so the fetching is thin and the rule
that decides which workflows are stranded is pure and tested here. Getting
this rule wrong is expensive in both directions: too loose and it re-bookmarks
workflows that were reachable all along, too strict and the names stay blocked.
"""

from types import SimpleNamespace

from beanie import PydanticObjectId

from scripts.adopt_orphaned_workflows import (
    bookmarked_workflow_ids,
    is_orphan,
    referenced_workflow_ids,
)


def _library(items):
    return SimpleNamespace(items=items)


def _item(target_id):
    return SimpleNamespace(id=PydanticObjectId(), item_id=target_id)


class TestBookmarkedWorkflowIds:
    def test_counts_a_row_a_library_actually_lists(self):
        wf_id = PydanticObjectId()
        item = _item(wf_id)

        assert bookmarked_workflow_ids([_library([item.id])], [item]) == {wf_id}

    def test_ignores_a_row_no_library_lists(self):
        # Exactly what the old Library delete left behind. Such a row renders
        # in no listing, so treating it as a bookmark would leave the workflow
        # invisible and its name blocked — the bug this script repairs.
        wf_id = PydanticObjectId()
        item = _item(wf_id)

        assert bookmarked_workflow_ids([_library([])], [item]) == set()

    def test_a_bookmark_in_any_library_counts(self):
        # Shared to a team and removed from the owner's personal library: still
        # reachable, still not an orphan.
        wf_id = PydanticObjectId()
        item = _item(wf_id)
        personal, team = _library([]), _library([item.id])

        assert bookmarked_workflow_ids([personal, team], [item]) == {wf_id}


class TestReferencedWorkflowIds:
    def test_collects_automations_pins_and_verified_metadata(self):
        a, b, c = (str(PydanticObjectId()) for _ in range(3))

        result = referenced_workflow_ids(
            [SimpleNamespace(action_id=a)],
            [SimpleNamespace(target_id=b)],
            [SimpleNamespace(item_id=c)],
        )

        assert result == {a, b, c}

    def test_skips_an_automation_with_no_action_yet(self):
        # A half-configured automation points at nothing; it must not pull an
        # unrelated workflow out of the cleanup.
        assert referenced_workflow_ids([SimpleNamespace(action_id=None)], [], []) == set()


class TestIsOrphan:
    def test_unbookmarked_and_unreferenced_is_an_orphan(self):
        wf = SimpleNamespace(id=PydanticObjectId())

        assert is_orphan(wf, set(), set()) is True

    def test_bookmarked_is_not_an_orphan(self):
        wf = SimpleNamespace(id=PydanticObjectId())

        assert is_orphan(wf, {wf.id}, set()) is False

    def test_referenced_by_another_surface_is_not_an_orphan(self):
        # An automation's action or a project pin keeps a workflow reachable
        # and manageable from that surface even with no library bookmark.
        wf = SimpleNamespace(id=PydanticObjectId())

        assert is_orphan(wf, set(), {str(wf.id)}) is False

    def test_reference_ids_are_matched_as_strings_not_object_ids(self):
        # Regression guard on the two id representations the script juggles:
        # bookmarks come back as PydanticObjectId (Workflow.id), while
        # automations, pins and verified metadata store the id as a string.
        # Comparing the wrong pair silently matches nothing, which would adopt
        # workflows that a live automation still runs.
        wf = SimpleNamespace(id=PydanticObjectId())

        assert is_orphan(wf, set(), {wf.id}) is True
        assert is_orphan(wf, set(), {str(wf.id)}) is False
