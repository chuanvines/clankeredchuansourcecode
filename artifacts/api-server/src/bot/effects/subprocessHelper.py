from subprocess import run, PIPE, DEVNULL
import sys
import traceback

def get_output(cmd):
    try:
        result = run(cmd, stdout=PIPE, stderr=PIPE)
        return result.stdout.decode(errors='replace').strip()
    except Exception:
        return ""

def silent_run(cmd):
    try:
        run(cmd, stdout=DEVNULL, stderr=DEVNULL)
    except Exception:
        pass

def printEx(ex):
    traceback.print_exc(file=sys.stderr)
