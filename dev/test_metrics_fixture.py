"""Tests for the shape of the development metrics fixture.

Run with: python3 -m unittest discover -s dev -p 'test_*.py'
"""
import importlib.util
import os
import re
import unittest

DEV_DIR = os.path.dirname(os.path.abspath(__file__))

# The plugin's default CPU expression (DEFAULT_CPU_EXPR in
# src/pages/JobSearch/jobMetrics.ts), which these tests evaluate by hand:
#   avg by(instance) (1 - rate(node_cpu_seconds_total{mode="idle",...}[5m])) * 100
SERIES_RE = re.compile(r'^(\w+)\{(.*)\} (\S+)')
LABEL_RE = re.compile(r'(\w+)="([^"]*)"')


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(DEV_DIR, name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cpu_samples(lines):
    """Map each node_cpu_seconds_total label set to its value."""
    samples = {}
    for line in lines:
        match = SERIES_RE.match(line)
        if not match or match.group(1) != "node_cpu_seconds_total":
            continue
        labels = tuple(sorted(LABEL_RE.findall(match.group(2))))
        samples[labels] = float(match.group(3))
    return samples


class CPUFixtureAssertions:
    def assert_node_exporter_shape(self, first, second, seconds):
        """Check two scrapes of one node `seconds` apart."""
        self.assertTrue(first, "no node_cpu_seconds_total samples")
        self.assertEqual(set(first), set(second))
        busy = []
        per_cpu = {}
        for labels, value in second.items():
            label_map = dict(labels)
            self.assertIn("cpu", label_map, f"series without a cpu label: {labels}")
            rate = (value - first[labels]) / seconds
            self.assertGreaterEqual(rate, 0, f"counter went down: {labels}")
            per_cpu.setdefault(label_map["cpu"], 0.0)
            per_cpu[label_map["cpu"]] += rate
            if label_map["mode"] == "idle":
                busy.append(1 - rate)
        # Each CPU spends one second per second across its modes.
        for cpu, total in per_cpu.items():
            self.assertAlmostEqual(total, 1.0, places=2, msg=f"cpu {cpu}")
        percent = sum(busy) / len(busy) * 100
        self.assertGreaterEqual(percent, 0)
        self.assertLessEqual(percent, 100)


class GenerateMetricsTest(CPUFixtureAssertions, unittest.TestCase):
    def test_cpu_series_have_node_exporter_shape(self):
        gen = load_script("generate-metrics.py")
        for node_name in ("gpu-node001", "h100-node01", "cpu-node001"):
            counters = gen.CounterState()
            profile = gen.PROFILES["train"]
            ts = gen.NOW - 3600
            first = cpu_samples(gen.generate_samples_for_node(node_name, profile, ts, counters, 60))
            for step in range(1, 6):
                lines = gen.generate_samples_for_node(node_name, profile, ts + 60 * step, counters, 60)
            self.assert_node_exporter_shape(first, cpu_samples(lines), 5 * 60)


class MockExporterTest(CPUFixtureAssertions, unittest.TestCase):
    def test_cpu_series_have_node_exporter_shape(self):
        mock = load_script("mock-exporter.py")
        for node_name in ("gpu-node001", "cpu-node001"):
            profile = mock.PROFILES["train"]
            # Scrapes an hour after the exporter started, 15 s apart.
            start = mock.START_TIME + 3600
            previous = cpu_samples(mock.generate_node_metrics(node_name, profile, start))
            for step in range(1, 21):
                current = cpu_samples(mock.generate_node_metrics(node_name, profile, start + 15 * step))
                self.assert_node_exporter_shape(previous, current, 15)
                previous = current


if __name__ == "__main__":
    unittest.main()
