import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "relay" / "backup-state.sh"


class BackupState(unittest.TestCase):
    def test_custom_databases_are_backed_up_and_secrets_are_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state, arb = root / "custom-state.db", root / "custom-arb.db"
            for path, value in ((state, "state"), (arb, "arb")):
                db = sqlite3.connect(path)
                db.execute("create table marker (value text)")
                db.execute("insert into marker values (?)", (value,))
                db.commit()
                db.close()
            config, logs, backups = root / "config", root / "logs", root / "backups"
            config.mkdir()
            logs.mkdir()
            (config / "settings.json").write_text("{}")
            (config / "secrets.env").write_text("TOKEN=nope")
            env = dict(os.environ, HERDR_STATE_DB=str(state), HERDR_ARBITER_DB=str(arb),
                       HERDR_CONFIG_DIR=str(config), HERDR_LOG_DIR=str(logs),
                       HERDR_BACKUP_DIR=str(backups))

            subprocess.run([SCRIPT], env=env, check=True, capture_output=True, text=True)

            made = list(backups.glob("[0-9]*"))
            self.assertEqual(1, len(made))
            self.assertTrue((made[0] / "state.sqlite3").is_file())
            self.assertTrue((made[0] / "arbitration.sqlite3").is_file())
            self.assertTrue((made[0] / "config" / "settings.json").is_file())
            self.assertFalse((made[0] / "config" / "secrets.env").exists())
            self.assertEqual([], list(backups.glob(".backup.*")))

    def test_failed_copy_is_not_published_as_a_fresh_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            broken, backups = root / "broken.db", root / "backups"
            broken.write_text("not sqlite")
            env = dict(os.environ, HERDR_STATE_DB=str(broken),
                       HERDR_ARBITER_DB=str(root / "missing.db"),
                       HERDR_CONFIG_DIR=str(root / "missing-config"),
                       HERDR_LOG_DIR=str(root / "missing-logs"),
                       HERDR_BACKUP_DIR=str(backups))

            done = subprocess.run([SCRIPT], env=env, capture_output=True, text=True)

            self.assertNotEqual(0, done.returncode)
            self.assertEqual([], list(backups.glob("[0-9]*")))
            self.assertEqual([], list(backups.glob(".backup.*")))


if __name__ == "__main__":
    unittest.main()
