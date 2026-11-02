"""Exercise the stack launcher without Docker, model downloads, or credentials."""

import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import unittest


class StackModels(unittest.TestCase):
    def test_launches_with_both_real_embedder_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            scripts = root / "scripts/e2e"
            scripts.mkdir(parents=True)
            shutil.copyfile(pathlib.Path(__file__).with_name("stack.sh"), scripts / "stack.sh")
            backend = root / "apps/backend/scripts"
            backend.mkdir(parents=True)
            bin_dir = root / "bin"
            bin_dir.mkdir()

            def executable(path, body):
                path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
                path.chmod(0o755)

            executable(backend / "fetch-onnxruntime.sh", "echo 'export ORT_DYLIB_PATH=/fake/ort.so'\n")
            executable(backend / "fetch-models.sh", "exit 0\n")
            executable(bin_dir / "docker", "exit 0\n")
            executable(bin_dir / "curl", 'test -f "$CAPTURE_ENV"\n')
            executable(bin_dir / "backend", 'env > "$CAPTURE_ENV"\nexec sleep 30\n')
            # Reserve a free port only for stack.sh's preflight, without starting a service.
            with socket.socket() as port:
                port.bind(("127.0.0.1", 0))
                number = port.getsockname()[1]
            for override in (False, True):
                with self.subTest(model_dir_override=override):
                    state = root / ("state-custom" if override else "state-default")
                    capture = root / ("env-custom" if override else "env-default")
                    env = {
                        **os.environ,
                        "PATH": f"{bin_dir}:{os.environ['PATH']}",
                        "BACKEND_BIN": str(bin_dir / "backend"),
                        "CAPTURE_ENV": str(capture),
                        "E2E_STATE_DIR": str(state),
                        "E2E_BACKEND_PORT": str(number),
                        "E2E_SKIP_MODELS": "0",
                    }
                    env.pop("MODEL_DIR", None)
                    models = root / "apps/backend/models"
                    if override:
                        models = root / "custom-models"
                        env["MODEL_DIR"] = str(models)
                    try:
                        result = subprocess.run(
                            ["bash", str(scripts / "stack.sh"), "up"],
                            env=env, text=True, capture_output=True, timeout=10,
                        )
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        values = dict(line.split("=", 1) for line in capture.read_text().splitlines())
                        self.assertEqual(values.get("SIGLIP2_MODEL_PATH"), str(models / "siglip2_base_patch16_224.onnx"))
                        self.assertEqual(values.get("DINO_MODEL_PATH"), str(models / "dinov2_small.onnx"))
                        self.assertEqual(values.get("ORT_DYLIB_PATH"), "/fake/ort.so")
                    finally:
                        pid = state / "backend.pid"
                        if pid.exists():
                            os.kill(int(pid.read_text()), 15)


if __name__ == "__main__":
    unittest.main()
