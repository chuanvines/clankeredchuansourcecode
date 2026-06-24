from os import path, remove
import shutil

def getDir(p):
    d = path.dirname(path.abspath(p))
    return d if d else "."

def getName(p):
    return path.splitext(path.basename(p))[0]

def getExt(p):
    return path.splitext(p)[1].lstrip('.')

def addPrefix(p, prefix):
    return path.join(getDir(p), prefix + path.basename(p))

def tryToDeleteFile(p):
    try:
        if path.isfile(p):
            remove(p)
    except Exception:
        pass

def tryToDeleteDir(p):
    try:
        if path.isdir(p):
            shutil.rmtree(p)
    except Exception:
        pass
