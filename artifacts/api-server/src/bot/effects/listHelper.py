import re as _re

def unwrap(lst):
    return [i for i in lst if i is not None]

def removeNone(lst):
    return [i for i in lst if i is not None]

def listReplace(lst, target, replacement):
    result = []
    for item in lst:
        if item == target:
            if isinstance(replacement, list):
                result.extend(replacement)
            else:
                result.append(replacement)
        else:
            result.append(item)
    return result

def trySplitBy(s, delimiters):
    for d in delimiters:
        if d in s:
            parts = s.split(d)
            return [p for p in parts if p.strip() != '']
    return [s] if s.strip() else []

def splitComplex(s, delimiters, maxsplit=0):
    pattern = '[' + _re.escape(delimiters) + ']'
    if maxsplit:
        parts = _re.split(pattern, s, maxsplit=maxsplit)
    else:
        parts = _re.split(pattern, s)
    return [p for p in parts if p]
