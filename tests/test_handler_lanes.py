#!/usr/bin/env python3
"""One lane per pane: what may overlap, and what may not.

A connection used to answer its messages strictly one at a time, so the longest handler was how
long everything behind it waited — 45 seconds at an agy pane whose send nobody could confirm, with
the client's next press sitting unread. Dispatching each message as a task fixes that and breaks
something else unless it is bounded: a paste arrives as several `send_text` messages and only the
last carries `submit`, so two chunks of one paste must not overlap.

The rule is the pane. Same pane, arrival order. Different panes, at the same time.

    .venv313/bin/python -m unittest discover -s tests -t tests -p test_handler_lanes.py
"""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "relay"))
import herdr_relay


class LaneTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.lanes = {}
        self.order = []

    async def work(self, name, hold=0.01):
        """One handler: says when it started, gives the loop a chance to run another, says when."""
        self.order.append(f"{name}:start")
        await asyncio.sleep(hold)
        self.order.append(f"{name}:end")

    def run_in(self, key, name, hold=0.01):
        return asyncio.create_task(
            herdr_relay.run_in_lane(self.lanes, key, self.work(name, hold)))

    async def test_one_pane_runs_its_messages_in_the_order_they_arrived(self):
        # The paste case. A slow first chunk must not let the second overtake it.
        tasks = [self.run_in("w1:p1", "first", 0.03), self.run_in("w1:p1", "second", 0)]
        await asyncio.gather(*tasks)
        self.assertEqual(["first:start", "first:end", "second:start", "second:end"], self.order)

    async def test_a_third_message_waits_behind_the_second(self):
        tasks = [self.run_in("w1:p1", str(n), 0.01) for n in range(3)]
        await asyncio.gather(*tasks)
        self.assertEqual(["0:start", "0:end", "1:start", "1:end", "2:start", "2:end"], self.order)

    async def test_two_panes_do_not_wait_for_each_other(self):
        # The whole point. A send being confirmed at one pane used to hold a read of another.
        tasks = [self.run_in("w1:p1", "slow", 0.05), self.run_in("w2:p1", "quick", 0)]
        await asyncio.gather(*tasks)
        self.assertEqual(["slow:start", "quick:start", "quick:end", "slow:end"], self.order)

    async def test_everything_without_a_pane_shares_one_lane(self):
        # Which is what keeps a roster's starts sequential: `start_agent` names no pane, and two in
        # flight at once can pick the same "Architect 2" out of the live agent list.
        tasks = [self.run_in("", "start", 0.03), self.run_in("", "next", 0)]
        await asyncio.gather(*tasks)
        self.assertEqual(["start:start", "start:end", "next:start", "next:end"], self.order)

    async def test_a_handler_that_raises_frees_its_lane(self):
        # Otherwise one bad message wedges that pane for the life of the connection.
        async def boom():
            raise RuntimeError("no")

        with self.assertRaises(RuntimeError):
            await herdr_relay.run_in_lane(self.lanes, "w1:p1", boom())
        await self.run_in("w1:p1", "after", 0)
        self.assertEqual(["after:start", "after:end"], self.order)


if __name__ == "__main__":
    unittest.main()
