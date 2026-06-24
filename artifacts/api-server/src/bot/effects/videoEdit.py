from time import time
import sys, ffmpeg

from collections import namedtuple
from subprocess  import DEVNULL, STDOUT, check_call, getoutput, run
from itertools   import repeat, chain
from operator    import itemgetter
from random      import randrange, uniform, shuffle as randshuffle, choice as randChoice
from shutil      import copyfile, rmtree
from string      import ascii_letters
from pydub       import AudioSegment as AS
from math        import ceil, pi as PI
from PIL         import Image
from os          import listdir, system, rename, remove, path, mkdir, makedirs
from re          import sub as re_sub, search as re_search

from subprocessHelper import *
from betterStutter    import stutterInputProcess
from videoCrasher     import videoCrasher
from AutotuneBot      import autotuneURL
from download         import download
from listHelper       import *
from pathHelper       import *
from addSounds        import addSounds
from fixPrint         import fixPrint
from datamosh         import datamosh
from ricecake         import ricecake
from captions         import normalcaption as capN, impact as capI, poster as capP, cap as capC
from ytp              import ytp

DELIMITERS = "= :;"
result = namedtuple("result", "success filename message", defaults = 3 * ' ')

def sign(x):
    return -1 if x < 0 else 1

def r(r1, r2):
    return uniform(r1, r2)

def str_int(n):
    return int(float(n))

def all_in(l1, l2):
    return all(i in l2 for i in l1)

def constrain(val, min_val, max_val):
    if val == None:
        return None
    if type(val)     == str:
        val     = float(val    )
    if type(min_val) == str:
        min_val = float(min_val)
    if type(max_val) == str:
        max_val = float(max_val)
    return min(max_val, max(min_val, val))

def translate(x, s1, e1, s2, e2, bounded = True, f = lambda x: x):
    if bounded:
        x = constrain(x, s1, e1)
    x = s2+(e2-s2)*((e1*f(x)-s1*f(e1))/((e1-s1)*f(e1)))
    return constrain(x, s2, e2)

def getImageRes(path):
    return Image.open(path).size

def getDur(filename):
    return get_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filename])

def checkAudio(filename):
    ac = get_output(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=duration", "-of", "default=noprint_wrappers=1:nokey=1", filename])
    return not (ac == "null" or ac.strip() == "" or "no streams" in ac)

def getSize(filename):
    cmd = ["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", filename.replace('\\', '/').replace('//', '/')]
    raw = get_output(cmd)
    for line in raw.splitlines():
        parts = [p.strip() for p in line.split('x')]
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[0]) > 0 and int(parts[1]) > 0:
            return parts
    # Fallback: try selecting only the video stream explicitly
    cmd2 = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", filename.replace('\\', '/').replace('//', '/')]
    raw2 = get_output(cmd2)
    for line in raw2.splitlines():
        parts = [p.strip() for p in line.split('x')]
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[0]) > 0 and int(parts[1]) > 0:
            return parts
    raise ValueError(f"getSize: could not determine video dimensions for '{filename}' (ffprobe output: {repr(raw)})")

def checkIfDurationIsUnderTime(name, time):
    nn = name
    try:
        h = float(getDur(name))
        if h > 1000000 or h < 0:
            nn = f"{getDir(name)}/{getName(name)}TIMECHECK.mp4"
            silent_run(["ffmpeg", "-y", "-i", name, "-c", "copy", nn])
            h = float(getDur(nn))
            remove(nn)
        if h < time:
            return True
        else:
            return False
    except Exception as e:
        fixPrint("TIMECHECK", e)
        tryToDeleteFile(nn)

def notNone(x):
    return x is not None

def lim(x, y, m):
    if x <= m and y <= m:
        return (x, y)
    f = m / max(x, y)
    return (x * f, y * f)

def fv(x):
    return 2 * (int(x) >> 1)

def forceNumber(n):
    n = re_sub(r'[^0-9.-]', '', n)
    n = n.replace('.', '#', 1).replace('.', '').replace('#', '.')
    n = ('-' if n.startswith('-') else '') + n.replace('-', '')
    if not any([i.isdigit() for i in n]):
        n = n + '1'
    return float(n)

def phraseArgs(args, par):
    final = []
    shorthands = {par[i][2]: i for i in par}
    args = list(filter(None, args.split('|')))
    for g in range(len(args)):
        group = []
        args[g] = trySplitBy(args[g], ",\n")
        for p in range(len(args[g])):
            args[g][p] = [i.strip() for i in splitComplex(args[g][p].strip(), DELIMITERS, 1)]
            if len(args[g][p]) == 0:
                continue
            if len(args[g][p]) == 1:
                args[g][p].append("1")
            args[g][p][0] = args[g][p][0].lower()

            if args[g][p][0] in par:
                pass
            elif args[g][p][0] in shorthands:
                args[g][p][0] = shorthands[args[g][p][0]]
            else:
                continue

            cPar = par[args[g][p][0]]
            if cPar[0] == S:
                args[g][p][1] = args[g][p][1].lstrip(DELIMITERS)
            else:
                if args[g][p][1].lower() in ["false", "none"]:
                    continue
                args[g][p][1] = forceNumber(args[g][p][1])

            group.append({
                'name' : args[g][p][0],
                'value': args[g][p][1],
                'order': p
            })
        final.append(group)
    return final

def hp(o):
    fixPrint(o)
    return o

def strArgs(args):
    return '|'.join([','.join([f"{o['name']}={o['value']}" for o in sorted(i, key = itemgetter('order'))]) for i in args])

def timecodeBreak(file, m):
    zero   = bytearray.fromhex("00000000")
    one    = bytearray.fromhex("00000001")
    big    = bytearray.fromhex("7FFFFFFF")
    bigNeg = bytearray.fromhex("80000000")
    huge   = bytearray.fromhex("FFFFFFFF")
    with open(file, "rb") as binaryFile:
        byteData = bytearray(binaryFile.read())
    o = byteData.find(b'mvhd', 0)
    if m == 1:
        byteData[o+16:o+20] = one
        byteData[o+20:o+24] = huge
    elif m == 2:
        byteData[o+16:o+20] = one
        byteData[o+20:o+24] = big
    elif m == 3:
        byteData[o+16:o+20] = one
        byteData[o+20:o+24] = bigNeg
    elif m == 4:
        byteData[o+16:o+20] = one
        byteData[o+20:o+24] = zero
        loc = -1
        while True:
            loc = byteData.find(b'mdhd', loc + 1)
            if loc == -1:
                break
            byteData[loc+20:loc+24] = zero  
    with open(file, 'wb') as new:
        new.write(byteData)

def edit(file, groupData, par, workingDir = "", resourceDir = "..", toVideo = False, toGif = False, disallowTimecodeBreak = False, HIDE_FFMPEG_OUT = True, HIDE_ALL_FFMPEG = True, SHOW_TIMER = False, fixPrint = fixPrint):
    videoFX = ['playreverse', 'hmirror', 'vmirror', 'lag', 'rlag', 'shake', 'fisheye', 'defisheye', 'zoom', 'dezoom', 'bottomtext', 'toptext', 'normalcaption', 'topcap', 'bottomcap', 'topcaption', 'bottomcaption', 'hypercam', 'bandicam', 'deepfry', 'contrast', 'hue', 'hcycle', 'speed', 'vreverse', 'areverse', 'reverse', 'wscale', 'hscale', 'sharpen', 'watermark', 'framerate', 'invert', 'wave', 'waveamount', 'wavestrength', 'hwave', 'hwaveamount', 'hwavestrength', 'acid', 'hcrop', 'vcrop', 'hflip', 'vflip', 'rotate', 'swapuv']
    audioFX = ['pitch', 'reverb', 'earrape', 'bass', 'mute', 'threshold', 'crush', 'wobble', 'music', 'sfx', 'volume', 'autotune']

    d = {i: None for i in par}
    for i in groupData:
        d[i['name']] = i['value']

    originalFile = file
    pat = getDir(file)
    e0  = getName(file)

    outputArgs = {'preset': 'veryfast', 'pix_fmt': 'yuv420p'}
    resetTime = True
    ctt = 0
    def timer(msg = 'Duration'):
        nonlocal resetTime, ctt
        if not SHOW_TIMER: return
        if resetTime:
            ctt = time()
            resetTime = not resetTime
        else:
            fixPrint(f"{msg}: {time() - ctt}")
            resetTime = not resetTime

    def getOrder(n):
        for i in groupData:
            if i['name'] == n:
                return i['order']
        return None

    def makeAudio(pre, dr):
        fNam = f"{pat}/{pre}{e0}.wav"
        import shutil
        if shutil.which("sox"):
            silent_run(["sox", "-n", "-r", "16000", "-c", "1", fNam, "trim", "0.0", str(dr)])
        else:
            silent_run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", f"anullsrc=r=16000:cl=mono",
                        "-t", str(dr), fNam])
        return fNam

    def qui(t):
        t = t.global_args("-hide_banner")
        if HIDE_FFMPEG_OUT:
            return t.global_args('-loglevel', 'fatal' if HIDE_ALL_FFMPEG else 'error')
        else:
            return t

    def applyBitrate(pre, VBR = None, ABR = None, **exArgs):
        if notNone(VBR):
            exArgs.update(video_bitrate = str(VBR))
        if notNone(ABR):
            exArgs.update(audio_bitrate = str(ABR))
        if hasAudio:
            return qui(ffmpeg.output(video, audio, f"{pat}/{pre}{e0}.{getExt(newName)}", **exArgs))
        else:
            return qui(ffmpeg.output(video       , f"{pat}/{pre}{e0}.{getExt(newName)}", **exArgs))

    def removeAudioFilters():
        nonlocal d
        for i in audioFX: d[i] = None

    e = path.splitext(file)
    ST, ET = None, None
    oldFormat = e[1]
    imageArray = [".png", ".jpg", ".jpeg"]

    if e[1] in imageArray:
        silent_run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-framerate", "1", "-i", file, "-c:v", "libx264", "-r", "2", "-vf", f"scale=w=ceil((iw)/2)*2:h=ceil((ih)/2)*2{',fps=3' if toVideo else ''}", "-pix_fmt", "yuv420p", "-max_muxing_queue_size", "1024", f"{pat}/{e0}.mp4"])

        remove(file)
        file = f"{pat}/{e0}.mp4"
        e = path.splitext(file)
        if toVideo:
            d['holdframe'] = 10
        else:
            removeAudioFilters()
            removeFilters = "reverse,vreverse,areverse,ytp,datamosh,ricecake,shake,stutter,shuffle,lag,rlag,repeatuntil,crash".split(',')
            for i in removeFilters:
                d[i] = None
    else:
        toVideo = False

    filtText = []
    try:
        width, height = getSize(file)
        if int(width) + int(height) > 800 or int(width) % 2 != 0 or int(height) % 2 != 0:
            filtText = ["-vf", "scale=2*ceil(trunc(iw*480/ih)/2):480"]
    except Exception as ex:
        fixPrint("Error getting size:", ex)
        pass

    startText, endText = [], []
    if notNone(d['start']):
        d['start'] = constrain(float(d['start']), 0, 30000) + 3.5 / 30
        ST = d['start']
        startText = ["-ss", str(ST)]
    if notNone(d['end']):
        d['end'] =   constrain(float(d['end'  ]), 0, 30000)
        ET = d['end']
        endText = ["-to", str(max(0.1, d['end']))]


    tmpArgs = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f"{e[0]}{e[1]}", 1, "-reset_timestamps", "1", "-break_non_keyframes", "1", "-max_muxing_queue_size", "1024", "-preset", "veryfast", 2, f'{pat}/RFM{e0}.mp4']
    tmpArgs = listReplace(tmpArgs, 1, startText + endText)
    tmpArgs = listReplace(tmpArgs, 2, filtText)
    silent_run(unwrap(removeNone(tmpArgs)))
    
    if notNone(d['selection']):
        if ST:
            tmpArgs = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f"{e[0]}{e[1]}", "-t", str(ST), "-reset_timestamps", "1", "-break_non_keyframes", "1", "-max_muxing_queue_size", "1024", "-preset", "veryfast", 1, f"{pat}/START_{e0}.mp4"]
            silent_run(unwrap(removeNone(listReplace(tmpArgs, 1, filtText))))
        if ET:
            tmpArgs = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f"{e[0]}{e[1]}", "-ss", str(ET), "-reset_timestamps", "1", "-break_non_keyframes", "1", "-max_muxing_queue_size", "1024", "-preset", "veryfast", 1, f"{pat}/END_{e0}.mp4"]
            silent_run(unwrap(removeNone(listReplace(tmpArgs, 1, filtText))))


    remove(file)
    file = f"{pat}/{e0}.mp4"
    rename(f"{pat}/RFM{e0}.mp4", file)
    e = path.splitext(file)

    newName = e[0]+".mp4"

    DURATION = getDur(newName)
    width, height = getSize(newName)

    vidHasAudio = True
    hasAudio = True
    audio = None

    if notNone(d['holdframe']):
        d['holdframe'] = constrain(d['holdframe'], 0.1, 12)
        silent_run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", newName, "-frames:v", "1", f"{pat}/FIRST_FRAME_{e0}.png"])
        video = ffmpeg.input(f"{pat}/FIRST_FRAME_{e0}.png", loop = 1, r = 30, t = d['holdframe'])
        DURATION = d['holdframe']

    if toGif or not checkAudio(newName):
        vidHasAudio = False
    if notNone(d['selection']):
        OGvidAudio = vidHasAudio

    if toGif:
        vidHasAudio = False
        hasAudio = False
        removeAudioFilters()
    elif not vidHasAudio:
        if (notNone(d['sfx']) or notNone(d['music'])):
            makeAudio("GEN", DURATION)
            audio = ffmpeg.input(f"{pat}/GEN{e0}.wav")
            hasAudio = True
        else:
            hasAudio = False
            removeAudioFilters()
    else:
        if notNone(d['holdframe']):
            makeAudio("HFA", d['holdframe'])
            audio = ffmpeg.input(f"{pat}/HFA{e0}.wav")

    orderedVideoFX = sorted(filter(lambda x: notNone(d[x]), videoFX), key=getOrder)
    orderedAudioFX = sorted(filter(lambda x: notNone(d[x]), audioFX), key=getOrder)
    if "mute" in orderedAudioFX:
        orderedAudioFX = orderedAudioFX[orderedAudioFX.index("mute"):]

    s = ffmpeg.input(file)

    if notNone(d['holdframe']):
        if not toVideo:
            audio = ffmpeg.filter([audio, s.audio], "amix", duration = "first")
            hasAudio = True
    else:
        video = s.video
        if vidHasAudio:
            audio = s.audio
            hasAudio = True
    
    video = video.filter("scale", w = f"ceil((iw)/2)*2", h = f"ceil((ih)/2)*2")
    
    if notNone(d['abr']):
        d['abr'] = 100 + 1000 * constrain(100 - d['abr'], 1, 100)
    if notNone(d['vbr']):
        d['vbr'] = 100 + 2000 * constrain(100 - d['vbr'], 2, 100)

    if all_in(["topcaption", "bottomcaption"], orderedVideoFX):
        orderedVideoFX.remove("bottomcaption")
    if all_in(["topcap", "bottomcap"], orderedVideoFX):
        orderedVideoFX.remove("bottomcap")
    if all_in(["toptext", "bottomtext"], orderedVideoFX):
        orderedVideoFX.remove("bottomtext")
    if all_in(["wscale", "hscale"], orderedVideoFX):
        orderedVideoFX.remove("hscale")
    if all_in(["hue", "hcycle"], orderedVideoFX):
        orderedVideoFX.remove("hcycle")
    if all_in(["hcrop", "vcrop"], orderedVideoFX):
        orderedVideoFX.remove("vcrop")

    for i in [o for o in ["waveamount", "wavestrength"] if o in orderedVideoFX]:
        if "wave" in orderedVideoFX:
            orderedVideoFX.remove(i)
        else:
            orderedVideoFX[orderedVideoFX.index(i)] = "wave"

    for i in [o for o in ["hwaveamount", "hwavestrength"] if o in orderedVideoFX]:
        if "hwave" in orderedVideoFX:
            orderedVideoFX.remove(i)
        else:
            orderedVideoFX[orderedVideoFX.index(i)] = "hwave"

    if any(orderedVideoFX):
        def playreverse():
            nonlocal video, audio
            VS = video.split()
            video = VS[0]
            newVideo = VS[1].filter("reverse")
            if d['playreverse'] == 2:
                video = ffmpeg.concat(newVideo, video)
            else:
                video = ffmpeg.concat(video, newVideo)
            if hasAudio:
                APART = audio.asplit()
                audio = APART[0]
                newAudio = APART[1].filter("areverse")
                if d['playreverse'] == 2:
                    audio = ffmpeg.concat(newAudio, audio, v = 0, a = 1)
                else:
                    audio = ffmpeg.concat(audio, newAudio, v = 0, a = 1)
        
        def hmirror():
            nonlocal video, audio
            v2 = video.split()
            if str_int(d['hmirror']) >= 2:
                flip = v2[1].filter("crop", x = "in_w/2", out_w = "in_w/2").filter("hflip")
                video = v2[0].overlay(flip)
            else:
                flip = v2[1].filter("crop", x = 0, out_w = "in_w/2").filter("hflip")
                video = v2[0].overlay(flip, x = "main_w/2")

        def vmirror():
            nonlocal video, audio
            v2 = video.split()
            if str_int(d['vmirror']) >= 2:
                flip = v2[1].filter("crop", y = "in_h/2", out_h = "in_h/2").filter("vflip")
                video = v2[0].overlay(flip)
            else:
                flip = v2[1].filter("crop", y = 0, out_h = "in_h/2").filter("vflip")
                video = v2[0].overlay(flip, y = "main_h/2")

        def lag():
            nonlocal video, audio
            if d['lag'] < 0:
                d['lag'] = 2 * int(translate(abs(d['lag']), 1, 100, 2, 15))
                t = [str(i) for i in range(int(d['lag']))]
                randshuffle(t)
                frameOrder = '|'.join(t)
            else:
                d['lag'] = int(translate(d['lag'], 1, 100, 2, 15)) + 2
                frameOrder = '|'.join([str(v if i % 2 == 0 else d['lag'] - v) for i, v in enumerate(range(d['lag']))])
            video = video.filter("shuffleframes", frameOrder)

        def rlag():
            nonlocal video, audio
            d['rlag'] = constrain(int(d['rlag'] + 1), 2, 120)
            video = video.filter("random", d['rlag'])

        def shake():
            nonlocal video, audio
            d['shake'] = translate(d['shake'], 0, 100, 1.00125, 1.1, f = lambda x: x**1.7)
            video = video.filter("crop", f"in_w/{d['shake']}", f"in_h/{d['shake']}", "(random(0)*2-1)*in_w", "(random(1)*2-1)*in_h")

        def rotate():
            nonlocal video, audio
            video = video.filter("rotate",(d['rotate'])*PI/180)

        def swapuv():
            nonlocal video, audio
            video = video.filter("swapuv")
            
        def fisheye():
            nonlocal video, audio
            d['fisheye'] = int(constrain(d['fisheye'], 1, 2))
            for i in range(d['fisheye']):
                video = video.filter("v360" , input = "equirect", output = "ball")
                video = video.filter("scale", w = width, h = height)
            video = video.filter("setsar", r = 1)

        def defisheye():
            nonlocal video, audio
            d['defisheye'] = int(constrain(d['defisheye'], 1, 2))
            for i in range(d['defisheye']):
                video = video.filter("v360" , input = "ball", output = "equirect")
                video = video.filter("scale", w = width, h = height)
            video = video.filter("setsar", r = 1)

        
        def hcrop():
            nonlocal video, audio, width, height
            hcrop = f"{(tx := 1 - (constrain(d['hcrop'], 1, 95) if notNone(d['hcrop']) else 0) / 100)}*iw"
            vcrop = f"{(ty := 1 - (constrain(d['vcrop'], 1, 95) if notNone(d['vcrop']) else 0) / 100)}*ih"
            width  = str(int(int(width )*tx))
            height = str(int(int(height)*ty))
            video = video.filter("crop", hcrop, vcrop)
            

        def zoom():
            nonlocal video, audio
            flag = False
            if d['zoom'] < 0:
                d['zoom'] = abs(d['zoom'])
                flag = True
            d['zoom'] = constrain(d['zoom'], 1, 15)
            video = video.filter("crop", f"iw/{d['zoom']}", f"ih/{d['zoom']}")
            zoomargs = ["scale", f"in_w*{d['zoom']}", f"in_h*{d['zoom']}"]
            if not flag:
                video = video.filter(*zoomargs)
            else:
                video = video.filter(*zoomargs, flags = "neighbor")

        def dezoom():
            nonlocal video, audio
            d['dezoom'] = constrain(d['dezoom'], 1, 15)
            z = d['dezoom']
            video = video.filter("scale", f"iw/{z}", f"ih/{z}")
            video = video.filter("pad", f"iw*{z}", f"ih*{z}", "(ow-iw)/2", "(oh-ih)/2", color="black")

        def toptext():
            nonlocal video, audio, width, height
            capI(int(width), int(height), toptext = d['toptext'], bottomtext = d['bottomtext'], resourceDir = resourceDir).save(f"{pat}/impact{e0}.png")
            video = video.overlay(ffmpeg.input(f"{pat}/impact{e0}.png"))

        def topcaption():
            nonlocal video, audio, width, height
            capP(int(width), int(height), cap = d['topcaption'], bottomcap = d['bottomcaption'], resourceDir = resourceDir).save(f"{pat}/poster{e0}.png")
            video = ffmpeg.input(f"{pat}/poster{e0}.png").overlay(video, x = f"min(main_w,main_h)/20+0.5", y = f"min(main_w,main_h)/20+0.5")
            width, height = getSize(f"{pat}/poster{e0}.png")

        def normalcaption():
            nonlocal video, audio, width, height
            capN(int(width), int(height), cap = d['normalcaption'], resourceDir = resourceDir).save(f"{pat}/normalcaption{e0}.png")
            video = ffmpeg.input(f"{pat}/normalcaption{e0}.png").filter("pad", h = f"(ih+{height})+mod((ih+{height}), 2)").overlay(video, y = f"(main_h-{height})")
            height = str(int(height) + getImageRes(f"{pat}/normalcaption{e0}.png")[1])
            
        def cap():
            nonlocal video, audio, width, height
            if d['topcap']:
                capC(int(width), int(height), cap = d['topcap'], resourceDir = resourceDir).save(f"{pat}/topcap{e0}.png")
                video = ffmpeg.input(f"{pat}/topcap{e0}.png").filter("pad",h = f"(ih+{height})+mod((ih+{height}), 2)").overlay(video, y = f"(main_h-{height})")
                height = str(int(height) + getImageRes(f"{pat}/topcap{e0}.png")[1])
            if d['bottomcap']:
                capC(int(width), int(height), cap = d['bottomcap'], resourceDir = resourceDir).save(f"{pat}/bottomcap{e0}.png")
                capHeight = getImageRes(f"{pat}/bottomcap{e0}.png")[1]
                video = video.filter("pad", h = f"ih+{capHeight}+mod((ih+{capHeight}), 2)").overlay(ffmpeg.input(f"{pat}/bottomcap{e0}.png"), y = f"main_h-{capHeight}")
                height = str(int(height) + capHeight)

        def hypercam():
            nonlocal video, audio
            p = f"{resourceDir}/images/watermark/hypercam.png"
            if not path.isfile(p): return
            wm = ffmpeg.input(p, loop=1, t=float(DURATION)).filter("scale", w=int(width), h=int(height))
            video = video.overlay(wm)

        def bandicam():
            nonlocal video, audio
            p = f"{resourceDir}/images/watermark/bandicam.png"
            if not path.isfile(p): return
            wm = ffmpeg.input(p, loop=1, t=float(DURATION)).filter("scale", w=int(width), h=int(height))
            video = video.overlay(wm)

        def watermark():
            nonlocal video, audio, height
            height = int(height)
            d['watermark'] = ceil(constrain(d['watermark'], 1, 100) / 4.5)
            j = f"{resourceDir}/images/watermark"
            if not path.isdir(j):
                height = str(height)
                return
            watermarks = [f"{j}/{i}" for i in listdir(j)]
            t = [watermarks[int(r(0, len(watermarks)))] for i in range(d['watermark'])]
            dur = float(DURATION)
            vw = int(width)
            cb, ch = True, True
            for i in t:
                name = getName(i)
                if name in ["9gag", "memebase", "ifunny", "laugh"]:
                    iw, ih = getImageRes(i)
                    tw = vw
                    th = max(1, round(vw * ih / max(1, iw)))
                    height += th
                    wm = ffmpeg.input(i, loop=1, t=dur).filter("scale", w=tw, h=th)
                    video = video.filter("pad", w=vw, h=f"ih+{th}").overlay(wm, x=0, y=f"main_h-{th}")
                elif name == "mematic":
                    iw, ih = getImageRes(i)
                    tw = max(1, round(vw / 3))
                    th = max(1, round(tw * ih / max(1, iw)))
                    wm = ffmpeg.input(i, loop=1, t=dur).filter("scale", w=tw, h=th)
                    video = video.overlay(wm, x=f"main_w*0.05", y=f"main_h-{th}")
                elif name == "reddit":
                    wm = ffmpeg.input(i, loop=1, t=dur).filter("scale", w=vw, h=int(height))
                    video = video.overlay(wm, x=0, y=0)
                elif cb and name == "bandicam":
                    bandicam()
                    cb = False
                elif ch and name == "hypercam":
                    hypercam()
                    ch = False
                else:
                    iw, ih = getImageRes(i)
                    tw = max(1, round(vw / 4))
                    th = max(1, round(tw * ih / max(1, iw)))
                    wm = ffmpeg.input(i, loop=1, t=dur).filter("scale", w=tw, h=th)
                    video = video.overlay(wm, x=f"main_w-{tw}-10", y=f"main_h-{th}-10")
            height = str(height)

        def deepfry():
            nonlocal video, audio
            d['deepfry'] = constrain(d['deepfry'], -100, 100) / 10
            video = video.filter("hue", s = d['deepfry'])

        def contrast():
            nonlocal video, audio
            q = 2 * constrain(d['contrast'] * 10, 0, 1000)
            if q > 1000:
                q = -q
            video = video.filter("eq", saturation = 1 + (d['contrast'] / 100), contrast = 1 + q / 10)

        def framerate():
            nonlocal video, audio
            video = video.filter("fps", constrain(d['framerate'], 1, 30))

        def invert():
            nonlocal video, audio
            video = video.filter("negate")

        def hue():
            nonlocal video, audio
            if d['hue'] is None:
                d['hue'] = 0
            else:
                d['hue'] = int(3.6 * constrain(d['hue'], 0, 100))
            if d['hcycle'] is None:
                d['hcycle'] = 0
            else:
                d['hcycle'] = constrain(d['hcycle'], 0, 100) / 10

            video = video.filter("hue", h=f'''{d['hue']} + ({d['hcycle']}*360*t)''')

        def speed():
            nonlocal video, audio
            if d['speed'] < 0:
                d['reverse'] = 1
            q = constrain(abs(d['speed']), 0.5, 25)
            video = video.filter("setpts", (str(1 / q)+"*PTS"))
            if hasAudio:
                audio = audio.filter("atempo", q)

        def vreverse():
            nonlocal video, audio
            video = video.filter("reverse")

        def areverse():
            nonlocal video, audio
            if hasAudio:
                audio = audio.filter("areverse")

        def reverse():
            vreverse()
            areverse()

        def wscale():
            nonlocal video, audio, width, height
            scaleX = constrain(ceil(str_int(d['wscale']) / 2) * 2, -600, 600) if notNone(d['wscale']) else "iw"
            scaleY = constrain(ceil(str_int(d['hscale']) / 2) * 2, -600, 600) if notNone(d['hscale']) else "ih"
            if scaleX != "iw":
                if scaleX < 0:
                    video = video.filter("hflip")
                scaleX = max(32, abs(scaleX))
                width = str(scaleX)
            if scaleY != "ih":
                if scaleY < 0:
                    video = video.filter("vflip")
                scaleY = max(32, abs(scaleY))
                height = str(scaleY)
            video = video.filter("scale", w = scaleX, h = scaleY, flags = "neighbor")

        def hflip():
            nonlocal video, audio
            video = video.filter("hflip")

        def vflip():
            nonlocal video, audio
            video = video.filter("vflip")

        def sharpen():
            nonlocal video, audio

            kw = {}
            if d['sharpen'] < 0:
                d['sharpen'] = abs(d['sharpen'])
                kw["flags"] = "neighbor"
            d['sharpen'] = translate(d['sharpen'], 0, 100, 0.99, 50, f = lambda x: x**3)

            video = video.filter("scale", w = f"iw/{d['sharpen'] + 1}", h = f"ih/{d['sharpen'] + 1}", **kw)
            a = int(d['sharpen'])
            for x in [1 for i in range(a)]+[d['sharpen'] - a]:
                video = video.filter('cas', x)
            video = video.filter("scale", w = f"iw*{d['sharpen'] + 1}", h = f"ih*{d['sharpen'] + 1}", **kw).filter("scale", w = "iw+mod(iw,2)", h = "ih+mod(ih,2)", flags = "neighbor")

        def acid():
            nonlocal video, audio
            d['acid'] = translate(d['acid'], 1, 100, 1, 10000, f = lambda x: x**2)
            video = video.filter("amplify", 3, d['acid']).filter("scale", w = "iw/4+mod(iw/4,2)", h = "ih/4+mod(ih/4,2)", flags = "neighbor")

        def wave():
            nonlocal video, audio
            if notNone(d['wave']):
                d['wave'] = constrain(d['wave'], -100, 100)
            else:   
                d['wave'] = 0
            if notNone(d['waveamount']):
                d['waveamount'] = constrain(d['waveamount'], 1, 100)
            else:
                d['waveamount'] = 10
            if notNone(d['wavestrength']):
                d['wavestrength'] = constrain(d['wavestrength'], 1, 100)
            else:
                d['wavestrength'] = 20
            v = f"p(X,floor(Y+sin(T*{d['wave']/10}+X*{d['waveamount']/100})*{d['wavestrength']}))"
            video = video.filter("geq", r = v, g = v, b = v)

        def hwave():
            nonlocal video, audio
            if notNone(d['hwave']):
                d['hwave'] = constrain(d['hwave'], -100, 100)
            else:
                d['hwave'] = 0
            if notNone(d['hwaveamount']):
                d['hwaveamount'] = constrain(d['hwaveamount'], 1, 100)
            else:
                d['hwaveamount'] = 10
            if notNone(d['hwavestrength']):
                d['hwavestrength'] = constrain(d['hwavestrength'], 1, 100)
            else:
                d['hwavestrength'] = 20
            v = f"p(floor(X+sin(T*{d['hwave']/10}+Y*{d['hwaveamount']/100})*{d['hwavestrength']}),Y)"
            video = video.filter("geq", r = v, g = v, b = v)

        vidBind = {
            'playreverse': playreverse,
            'hmirror': hmirror,
            'vmirror': vmirror,
            'lag': lag,
            'rlag': rlag,
            'shake': shake,
            'fisheye': fisheye,
            'defisheye': defisheye,
            'zoom': zoom,
            'dezoom': dezoom,
            'bottomtext': toptext,
            'toptext': toptext,
            'normalcaption': normalcaption,
            'topcap': cap,
            'bottomcap': cap,
            'topcaption': topcaption,
            'bottomcaption': topcaption,
            'hypercam': hypercam,
            'bandicam': bandicam,
            'deepfry': deepfry,
            'contrast': contrast,
            'hue': hue,
            'hcycle': hue,
            'speed': speed,
            'vreverse': vreverse,
            'areverse': areverse,
            'reverse': reverse,
            'wscale': wscale,
            'hscale': wscale,
            'sharpen': sharpen,
            'watermark': watermark,
            'framerate': framerate,
            'invert': invert,
            'wave': wave,
            'waveamount': wave,
            'wavestrength': wave,
            'hwave': hwave,
            'hwaveamount': hwave,
            'hwavestrength': hwave,
            'acid': acid,
            'hcrop': hcrop,
            'vcrop': hcrop,
            'hflip': hflip,
            'vflip': vflip,
            'rotate': rotate,
            'swapuv': swapuv
        }

        for i in orderedVideoFX:
            vidBind[i]()

    if any(orderedAudioFX):
        if notNone(d['volume']):
            d['volume'] = constrain(d['volume'], 0, 2000)
            audio = audio.filter("volume", d['volume'])
            orderedAudioFX.remove('volume')

        qui(audio.output(f"{pat}/{e0}.wav", acodec='pcm_s16le').overwrite_output()).run()

        def exportSox(INPRE, OUTPRE):
            nonlocal SOXCMD
            SOXCMD = ["sox", f"{pat}/{INPRE}{e0}.wav", "-e", "signed-integer", "-b", "16", f"{pat}/{OUTPRE}{e0}.wav"] + SOXCMD
            silent_run(SOXCMD)
            SOXCMD = []

        def _sox_apply(AUDPRE, tag, filter_name, **filter_kwargs):
            import os as _os
            out_wav = f"{pat}/{tag}{e0}.wav"
            try:
                qui(ffmpeg.input(f"{pat}/{AUDPRE}{e0}.wav")
                    .filter(filter_name, **filter_kwargs)
                    .output(out_wav, acodec='pcm_s16le')
                    .overwrite_output()).run()
                if _os.path.isfile(out_wav):
                    return tag
            except Exception:
                pass
            return AUDPRE

        def mute(SOXCMD, AUDPRE):
            return _sox_apply(AUDPRE, "MUTE", 'volume', volume=0)

        def threshold(SOXCMD, AUDPRE):
            n = -(50 - constrain(d['threshold'], 1, 100) / 2)
            pts = f'-80/-80|{n - 0.1:.2f}/-80|{n:.2f}/{n:.2f}|0/0'
            return _sox_apply(AUDPRE, "THRESHOLD", 'compand',
                              attacks='0.1', decays='0.2', points=pts,
                              gain=0, initial_volume=-100, delay=0.1)

        def bass(SOXCMD, AUDPRE):
            raw = translate(d['bass'] / 100, -1, 1, -1000, 1000,
                            f=lambda x: sign(x) * (abs(x) / 20 if abs(x) < 0.7 else (abs(x) - 0.2675) ** 4))
            db = constrain(raw, -30, 30)
            return _sox_apply(AUDPRE, "BASS", 'bass', gain=db)

        def earrape(SOXCMD, AUDPRE):
            db = constrain(d['earrape'], 0, 100) * 10
            return _sox_apply(AUDPRE, "EARRAPE", 'volume', volume=f'{db}dB')
        def pitch(SOXCMD, AUDPRE):
            import os as _os
            MAX_SEMITONES = 36

            def shift_wav(in_wav, out_wav, semitones):
                pitch_ratio = 2 ** (semitones / 12)
                try:
                    qui(ffmpeg.input(in_wav)
                        .filter('rubberband', pitch=f'{pitch_ratio:.6f}', tempo=1)
                        .output(out_wav, acodec='pcm_s16le')
                        .overwrite_output()).run()
                except Exception:
                    pass

            val = str(d['pitch'])
            parts = [p.strip() for p in val.split(';') if p.strip()]

            if len(SOXCMD) > 0:
                exportSox(AUDPRE, "PRE_PITCH")
                AUDPRE = "PRE_PITCH"

            if len(parts) > 1:
                mix_inputs = []
                for idx, part in enumerate(parts):
                    raw = forceNumber(part)
                    if abs(raw) >= 20:
                        raw /= 10
                    raw = constrain(raw, -MAX_SEMITONES, MAX_SEMITONES)
                    out_wav = f"{pat}/PITCH{idx}{e0}.wav"
                    shift_wav(f"{pat}/{AUDPRE}{e0}.wav", out_wav, raw)
                    if _os.path.isfile(out_wav):
                        mix_inputs.append(ffmpeg.input(out_wav))
                if mix_inputs:
                    qui(ffmpeg.filter(
                        mix_inputs, "amix",
                        inputs=len(mix_inputs), duration="first"
                    ).output(f"{pat}/PITCHMIX{e0}.wav", acodec='pcm_s16le')
                    .overwrite_output()).run()
                    return "PITCHMIX"
            else:
                raw = forceNumber(parts[0] if parts else val)
                if abs(raw) >= 20:
                    raw /= 10
                raw = constrain(raw, -MAX_SEMITONES, MAX_SEMITONES)
                out_wav = f"{pat}/PITCH_OUT{e0}.wav"
                shift_wav(f"{pat}/{AUDPRE}{e0}.wav", out_wav, raw)
                if _os.path.isfile(out_wav):
                    return "PITCH_OUT"
            return AUDPRE
        def reverb(SOXCMD, AUDPRE):
            import os as _os
            room = (25 + constrain(d['reverb'], 0, 100) * (3 / 4 - 0.01)) / 100
            rbd = 0.0
            if d['reverbdelay'] is not None:
                rbd = 5 * constrain(float(d['reverbdelay']), 0, 99.9)
            delay_ms = max(20, int(rbd) if rbd > 0 else int(room * 200))
            decay = min(0.88, room * 0.95)
            out_wav = f"{pat}/REVERB{e0}.wav"
            try:
                qui(ffmpeg.input(f"{pat}/{AUDPRE}{e0}.wav")
                    .filter('aecho', in_gain=0.8, out_gain=0.9,
                            delays=f'{delay_ms}|{delay_ms * 2}|{delay_ms * 3}',
                            decays=f'{decay:.3f}|{decay * 0.5:.3f}|{decay * 0.25:.3f}')
                    .output(out_wav, acodec='pcm_s16le')
                    .overwrite_output()).run()
                if _os.path.isfile(out_wav):
                    return "REVERB"
            except Exception:
                pass
            return AUDPRE
        def crush(SOXCMD, AUDPRE):
            import wave as _wave, array as _array
            if len(SOXCMD) > 0:
                exportSox(AUDPRE, "PRE_CRUSH")
                AUDPRE = "PRE_CRUSH"
            try:
                d['crush'] = int(translate(d['crush'], 0, 100, 1, 10))
                n1 = (2 ** d['crush'])  # block size in ms
                in_path  = f"{pat}/{AUDPRE}{e0}.wav"
                out_path = f"{pat}/CRUSH{e0}.wav"
                with _wave.open(in_path, 'rb') as wf:
                    nch = wf.getnchannels()
                    sw  = wf.getsampwidth()
                    fr  = wf.getframerate()
                    raw = wf.readframes(wf.getnframes())
                fmt = {1: 'B', 2: 'h', 4: 'i'}.get(sw, 'h')
                samples = _array.array(fmt, raw)
                spm   = max(1, fr * nch // 1000)   # interleaved samples per 1 ms
                block = max(1, n1 * spm)            # interleaved samples per n1 ms block
                out   = _array.array(fmt)
                for start in range(0, len(samples), block):
                    src    = samples[start : start + spm]
                    if not src:
                        break
                    needed = min(block, len(samples) - start)
                    reps, rem = divmod(needed, len(src))
                    out.extend(src * reps)
                    out.extend(src[:rem])
                with _wave.open(out_path, 'wb') as wf_out:
                    wf_out.setnchannels(nch)
                    wf_out.setsampwidth(sw)
                    wf_out.setframerate(fr)
                    wf_out.writeframes(out.tobytes())
                return "CRUSH"
            except Exception:
                return AUDPRE
        def wobble(SOXCMD, AUDPRE):
            import os as _os
            if len(SOXCMD) > 0:
                exportSox(AUDPRE, "PRE_WOB")
                AUDPRE = "PRE_WOB"
            d['wobble'] = ceil(translate(d['wobble'], 0, 100, 1, 100, f = lambda x: x ** 3))
            out_wav = f"{pat}/WOBBLE{e0}.wav"
            try:
                qui(ffmpeg.input(f"{pat}/{AUDPRE}{e0}.wav")
                    .filter("vibrato", d['wobble'], 1)
                    .output(out_wav, acodec='pcm_s16le')
                    .overwrite_output()).run()
                if _os.path.isfile(out_wav):
                    return "WOBBLE"
            except Exception:
                pass
            return AUDPRE
        def music(SOXCMD, AUDPRE):
            import os as _mos
            try:
                if notNone(d['musicdelay']):
                    d['musicdelay'] = constrain(d['musicdelay'], 0, DURATION)
                bg_path = f"{pat}/BG{e0}.mp3"
                if download(bg_path, d['music'], skip = d['musicskip'], delay = d['musicdelay'], duration = 120, video = False):
                    bg_size = _mos.path.getsize(bg_path) if _mos.path.isfile(bg_path) else 0
                    fixPrint(f"[music] BG downloaded: {bg_path} ({bg_size} bytes)")
                    if len(SOXCMD) > 0:
                        exportSox(AUDPRE, "PRE_MUSIC")
                        AUDPRE = "PRE_MUSIC"
                    aud_path = f"{pat}/{AUDPRE}{e0}.wav"
                    aud_size = _mos.path.getsize(aud_path) if _mos.path.isfile(aud_path) else 0
                    fixPrint(f"[music] mixing: {aud_path} ({aud_size} bytes) + {bg_path}")
                    qui(ffmpeg.filter([ffmpeg.input(aud_path), ffmpeg.input(bg_path)], "amix", duration = "first").output(f"{pat}/MUSIC{e0}.wav", acodec='pcm_s16le').overwrite_output()).run()
                    return "MUSIC"
                else:
                    fixPrint(f"[music] download() returned False for: {d['music'][:80]}")
                    return AUDPRE
            except Exception as ex:
                fixPrint("music error.", ex)
                return AUDPRE
        def autotune(SOXCMD, AUDPRE):
            try:
                exe = f"{resourceDir}/AutotuneBot/autotune.exe"
                if not path.isfile(exe): return AUDPRE
                if len(SOXCMD) > 0:
                    exportSox(AUDPRE, "PRE_AUTOTUNE")
                    AUDPRE = "PRE_AUTOTUNE"
                autotuneURL(f"{pat}/{AUDPRE}{e0}.wav", d['autotune'], replaceOriginal = True, video = False, executableName = exe)
            except Exception as ex:
                fixPrint("autotune error.", ex)
                raise ex
                
            return AUDPRE
        def sfx(SOXCMD, AUDPRE):
            snd = f"{resourceDir}/sounds"
            if not path.isdir(snd): return AUDPRE
            if len(SOXCMD) > 0:
                exportSox(AUDPRE, "SFX")
                AUDPRE = "SFX"
            d['sfx'] = constrain(int(d['sfx']), 1, 100)
            addSounds(f"{pat}/{AUDPRE}{e0}.wav", d['sfx'], snd)
            return AUDPRE

        audBind = {
            'threshold': threshold,
            'bass'     : bass,
            'earrape'  : earrape,
            'pitch'    : pitch,
            'reverb'   : reverb,
            'crush'    : crush,
            'wobble'   : wobble,
            'autotune' : autotune,
            'music'    : music,
            'sfx'      : sfx,
            'mute'     : mute
        }

        timer()
        SOXCMD = []
        AUDPRE = ""

        for i in orderedAudioFX:
            AUDPRE = audBind[i](SOXCMD, AUDPRE)
        timer("Audio FX")
        
        if len(SOXCMD) > 0:
            exportSox(AUDPRE, "FINAL_AUD")
            AUDPRE = "FINAL_AUD"

        import os as _aos
        _aud_wav = f"{pat}/{AUDPRE}{e0}.wav"
        if not _aos.path.isfile(_aud_wav):
            fixPrint(f"[diag] MISSING audio wav: {_aud_wav!r} (AUDPRE={AUDPRE!r})")
            fixPrint(f"[diag] Files in pat: {sorted(_aos.listdir(pat))}")
        audio = ffmpeg.input(_aud_wav)

    if int(width) + int(height) > 800 or int(width) % 2 != 0 or int(height) % 2 != 0:
        video = video.filter("scale", "2*ceil(trunc(iw*480/ih)/2)", "480")
    video = video.filter("scale", w = "iw + mod(iw, 2)", h = "ih + mod(ih, 2)")

    s = applyBitrate('_', VBR = d['vbr'], ABR = d['abr'], **outputArgs)

    if notNone(d['fisheye']):
        s = s.global_args('-aspect', f"{width}:{height}")

    TMP = ffmpeg.overwrite_output(s)
    
    if not HIDE_FFMPEG_OUT:
        fixPrint(TMP.compile())
    timer()
    TMP.run()
    timer("Video FX")

    remove(newName)
    rename(f"{pat}/_{e0}.mp4", newName)

    customFilters = ['shuffle', 'stutter', 'ytp', 'datamosh', 'ricecake', 'glitch']
    customFilters = sorted(filter(lambda x: notNone(d[x]), customFilters), key=getOrder)

    def FXshuffle():
        nonlocal newName, hasAudio, DURATION, d
        stutterInputProcess(newName, '', hasAudio, entireShuffle = True, dur = DURATION)
    def FXglitch():
        nonlocal newName
        ricecake(newName, newName, 1, max(2, d['glitch'] / 12))
    def FXstutter():
        nonlocal newName, hasAudio, DURATION, d
        stutterInputProcess(newName, str(d['stutter']), hasAudio, dur = DURATION)
    def FXytp():
        nonlocal newName, hasAudio, DURATION, d
        d['ytp'] = ceil(constrain(d['ytp'], 0, 100) / 10 * (float(DURATION) / 8))
        ytp(newName, int(d['ytp']), hasAudio)
    def FXdatamosh():
        nonlocal newName, hasAudio, d
        datamosh(newName, f"{pat}/datamosh_{e0}.mp4", replace_input = True, has_audio = hasAudio)
    def FXricecake():
        nonlocal newName, hasAudio, DURATION, d
        d['ricecake'] = constrain(d['ricecake'], 0, 100)
        ricecake(newName, newName, 0.08 * (d['ricecake'] / 100), d['ricecake'] / 5, speed = False)

    customFilterBind = {
        'shuffle': FXshuffle,
        'stutter': FXstutter,
        'ytp': FXytp,
        'datamosh': FXdatamosh,
        'ricecake': FXricecake,
        'glitch': FXglitch
    }
    timer()
    for i in customFilters:
        try:
            customFilterBind[i]()
        except NotImplementedError as nie:
            fixPrint(f"Skipping {i}: {nie}")
    timer("Custom filter time:")

    if not toGif and notNone(d['repeatuntil']):
        d['repeatuntil'] = constrain(d['repeatuntil'], 1, 45)
        changedName = f'{addPrefix(newName, "REPEAT")}.mp4'
        silent_run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", newName, "-t", d['repeatuntil'], "-c", "copy", changedName])
        remove(newName)
        rename(changedName, newName)

    if not toGif and notNone(d['repeat']):
        loops = max(2, min(20, int(d['repeat'])))
        ext   = getExt(newName)
        if ext in imageArray:
            pass  # images: nothing to loop
        else:
            loopedName = f'{addPrefix(newName, "LOOP")}.mp4'
            # Build concat filter for N copies with audio awareness
            vid_inputs = ''.join(f'[{k}:v]' for k in range(loops))
            aud_inputs = ''.join(f'[{k}:a]' for k in range(loops))
            # probe whether file has audio
            _has_audio = bool(get_output(["ffprobe", "-v", "error", "-select_streams", "a:0",
                                          "-show_entries", "stream=codec_type", "-of", "csv=p=0",
                                          newName]).strip())
            if _has_audio:
                filt = f"{vid_inputs}concat=n={loops}:v=1:a=1[v][a]"
                map_args = ["-map", "[v]", "-map", "[a]"]
            else:
                filt = f"{vid_inputs}concat=n={loops}:v=1:a=0[v]"
                map_args = ["-map", "[v]", "-an"]
            cmd = (["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                   + [arg for _ in range(loops) for arg in ["-i", newName]]
                   + ["-filter_complex", filt]
                   + map_args
                   + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                      "-pix_fmt", "yuv420p"]
                   + (["-c:a", "aac", "-b:a", "128k"] if _has_audio else [])
                   + [loopedName])
            silent_run(cmd)
            if path.isfile(loopedName) and path.getsize(loopedName) > 0:
                remove(newName)
                rename(loopedName, newName)

    if not toGif and notNone(d['boomerang']):
        loops = max(1, min(10, int(d['boomerang'])))
        ext   = getExt(newName)
        if ext not in imageArray:
            boomName = f'{addPrefix(newName, "BOOM")}.mp4'
            _has_audio = bool(get_output(["ffprobe", "-v", "error", "-select_streams", "a:0",
                                          "-show_entries", "stream=codec_type", "-of", "csv=p=0",
                                          newName]).strip())
            n = loops + 1  # number of fwd+rev pairs
            if _has_audio:
                filt = (
                    "[0:v]reverse[rv];[0:a]areverse[ra];"
                    + "".join(f"[0:v][0:a][rv][ra]" for _ in range(n))
                    + f"concat=n={2*n}:v=1:a=1[v][a]"
                )
                map_args = ["-map", "[v]", "-map", "[a]"]
            else:
                filt = (
                    "[0:v]reverse[rv];"
                    + "".join(f"[0:v][rv]" for _ in range(n))
                    + f"concat=n={2*n}:v=1:a=0[v]"
                )
                map_args = ["-map", "[v]", "-an"]
            cmd = (["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", newName]
                   + ["-filter_complex", filt]
                   + map_args
                   + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
                   + (["-c:a", "aac", "-b:a", "128k"] if _has_audio else [])
                   + [boomName])
            silent_run(cmd)
            if path.isfile(boomName) and path.getsize(boomName) > 0:
                remove(newName)
                rename(boomName, newName)

    if notNone(d['selection']):
        newOut = ffmpeg.input(newName)
        before, after = [], []
        SW, SH = None, None
        if ST and d['delfirst'] is None:
            start = ffmpeg.input(BEFORE := f"{pat}/START_{e0}.mp4")
            before = [start.video.filter("fps", fps = 30)]
            if OGvidAudio:
                before += [start.audio]
            elif hasAudio:
                before += [ffmpeg.input(makeAudio("BEFORE", getDur(BEFORE)))]

            if SW is None:
                SW, SH = getSize(f"{pat}/START_{e0}.mp4")
        if ET and d['dellast'] is None:
            end = ffmpeg.input(AFTER := f"{pat}/END_{e0}.mp4")
            after = [end.video.filter("fps", fps = 30)]
            if OGvidAudio:
                after += [end.audio]
            elif hasAudio:
                after += [ffmpeg.input(makeAudio("AFTER", getDur(AFTER)))]

            if SW is None:
                SW, SH = getSize(f"{pat}/END_{e0}.mp4")
        if SW is not None:
            newOutVideo = newOut.filter("scale", w = SW, h = SH).filter("fps", fps = 30)
            midSegment = [newOutVideo]
            if hasAudio:
                midSegment += [newOut.audio]
            newOut = ffmpeg.concat(*(before + midSegment + after), n = 1 + bool(ST) + bool(ET), v = 1, a = 1 if (hasAudio or OGvidAudio) else 0, unsafe = 1)
            hasSelAudio = bool(hasAudio or OGvidAudio)
            outKwargs = dict(
                vcodec  = "libx264",
                preset  = "veryfast",
                crf     = 23,
                pix_fmt = "yuv420p",
                movflags= "+faststart",
            )
            if hasSelAudio:
                outKwargs.update(acodec="aac", audio_bitrate="128k")
            else:
                outKwargs["an"] = None
            newOut = qui(newOut.output(f"{pat}/NEW_{e0}.mp4", **outKwargs))
            newOut.run()
            remove(newName)
            rename(f"{pat}/NEW_{e0}.mp4", newName)

    if notNone(d['timecode']) and not disallowTimecodeBreak:
        d['timecode'] = int(constrain(d['timecode'], 1, 4))
        timecodeBreak(newName, d['timecode'])

    newExt = "mp4"
    if (isImage := (oldFormat in imageArray and not toVideo)):
        originalFile = e[0] + ".png"
        silent_run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "fatal", "-i", newName, "-ss", "0", "-vframes", "1", originalFile])
        remove(newName)
        newExt = "png"
    else:
        originalFile = e[0] + ".mp4"
        newExt = "mp4"
    
    if toGif and not isImage:
        originalFile = e[0] + ".gif"
        newExt = "gif"
        qui(
            ffmpeg.filter(
                [ffmpeg.input(newName), ffmpeg.input(newName).filter("palettegen")],
                filter_name="paletteuse"
            ).filter("fps", fps = 30).output(e[0] + ".gif", loop = 60000)
        ).run()
        remove(newName)

    return originalFile

V, S = float, str

def videoEdit(originalFile, args, workingDir = "./", resourceDir = path.dirname(__file__), disallowTimecodeBreak = False, keepExtraFiles = False, SHOW_TIMER = False, HIDE_FFMPEG_OUT = True, HIDE_ALL_FFMPEG = True, fixPrint = fixPrint, durationUnder = None, allowRandom = True, logErrors = False):
    oldArgs = args
    par = {
        "vbr"           :[V, "vbr" , round(r(0, 100)) ],
        "abr"           :[V, "abr" , round(r(0, 100)) ],
        "earrape"       :[V, "er"  , round(r(0, 100)) ],
        "deepfry"       :[V, "df"  , round(r(0, 100)) ],
        "contrast"      :[V, "ct"  , round(r(0, 100)) ],
        "speed"         :[V, "sp"  , r(-4, 4) ],
        "timecode"      :[V, "timc", None ],
        "crash"         :[V, "crsh", None ],
        "bass"          :[V, "bs"  , round(r(0, 100)) ],
        "shuffle"       :[V, "sh"  , None ],
        "toptext"       :[S, "tt"  , str(r(0, 100)) ],
        "bottomtext"    :[S, "bt"  , str(r(0, 100)) ],
        "wscale"        :[S, "ws"  , int(r(-500, 500)) ],
        "hscale"        :[S, "hs"  , int(r(-500, 500)) ],
        "topcaption"    :[S, "tc"  , str(r(0, 100)) ],
        "bottomcaption" :[S, "bc"  , str(r(0, 100)) ],
        "threshold"     :[V, "thh" , None ],
        "hue"           :[V, "hue" , round(r(0, 100)) ],
        "hcycle"        :[V, "huec", round(r(0, 100)) ],
        "hypercam"      :[V, "hypc", None ],
        "bandicam"      :[V, "bndc", None ],
        "normalcaption" :[S, "nc"  , str(r(0, 100)) ],
        "topcap"        :[S, "cap" , str(r(0, 100)) ],
        "bottomcap"     :[S, "bcap", str(r(0, 100)) ],
        "reverse"       :[V, "rev" , 1 ],
        "vreverse"      :[V, "vrev", 1 ],
        "areverse"      :[V, "arev", 1 ],
        "playreverse"   :[V, "prev", int(r(1, 3)) ],
        "datamosh"      :[V, "dm"  , None ],
        "stutter"       :[S, "st"  , None ],
        "ytp"           :[V, "ytp" , None ],
        "fisheye"       :[V, "fe"  , int(r(1, 2)) ],
        "mute"          :[V, "mt"  , None ],
        "pitch"         :[S, "pch" , str(int(r(-100, 100))) ],
        "reverb"        :[V, "rv"  , int(r(0, 100)) ],
        "reverbdelay"   :[V, "rvd" , int(r(0, 100)) ],
        "hmirror"       :[V, "hm"  , 1 ],
        "vmirror"       :[V, "vm"  , 1 ],
        "ricecake"      :[V, "rc"  , None ],
        "sfx"           :[V, "sfx" , None ],
        "music"         :[S, "mus" , None ],
        "musicskip"     :[V, "muss", None ],
        "musicdelay"    :[V, "musd", None ],
        "volume"        :[V, "vol" , r(0.5, 3) ],
        "start"         :[V, "s"   , None ],
        "end"           :[V, "e"   , None ],
        "selection"     :[V, "se"  , None ],
        "holdframe"     :[V, "hf"  , None ],
        "delfirst"      :[V, "delf", None ],
        "dellast"       :[V, "dell", None ],
        "shake"         :[V, "shk" , int(r(1, 100)) ],
        "crush"         :[V, "cr"  , int(r(1, 100)) ],
        "lag"           :[V, "lag" , int(r(1, 100)) ],
        "rlag"          :[V, "rlag", int(r(1, 100)) ],
        "wobble"        :[V, "wub" , int(r(1, 100)) ],
        "zoom"          :[V, "zm"  , int(r(1, 5)) ],
        "dezoom"        :[V, "dz"  , None ],
        "hcrop"         :[V, "hcp" , int(r(10, 90)) ],
        "vcrop"         :[V, "vcp" , int(r(10, 90)) ],
        "hflip"         :[V, "hflp", 1 ],
        "vflip"         :[V, "vflp", 1 ],
        "sharpen"       :[V, "shp" , int(r(-100, 100)) ],
        "watermark"     :[V, "wtm" , None ],
        "framerate"     :[V, "fps" , int(r(5, 20)) ],
        "invert"        :[V, "inv" , 1 ],
        "wave"          :[V, "wav" , r(-100, 100) ],
        "waveamount"    :[V, "wava", r(0, 100) ],
        "wavestrength"  :[V, "wavs", r(0, 100) ],
        "hwave"         :[V, "hwav", r(-100, 100) ],
        "hwaveamount"   :[V, "hwava",r(0, 100) ],
        "hwavestrength" :[V, "hwavs",r(0, 100) ],
        "repeatuntil"   :[V, "repu", None ],
        "repeat"        :[V, "rep" , None ],
        "boomerang"     :[V, "boom", None ],
        "acid"          :[V, "acid", r(1, 100) ],
        "glitch"        :[V, "glch", None ],
        "autotune"      :[S, "atb" , None ],
        "defisheye"     :[V, "defe", int(r(1, 2)) ],
        "rotate"        :[V, "rot" , r(-180, 180) ],
        "swapuv"        :[V, "suv" , 1 ]
    }

    for i, v in par.items(): v[1], v[2] = v[2], v[1]

    kwargs = {}
    if 'tovid' in args.lower():
        kwargs['toVideo'] = 10
    if 'togif' in args.lower():
        kwargs['toGif'] = 10

    args = phraseArgs(args, par)

    randomSel = ''
    if len(args) == 0 or len(args[0]) == 0 and len(kwargs) == 0:
        if allowRandom:
            args = [[{'name': v, 'value': (float(par[v][1]) if par[v][0] == V else str(par[v][1])), 'order': i} for i, v in enumerate(par) if (notNone(par[v][1]) and r(0, 7) < 0.4)]]
            randomSel = " (Randomly selected)"
        else:
            return result(False, "", "Random values are disabled.")

    if durationUnder and getExt(originalFile) in ["mp4", "avi", "webm", "mov"]:
        if not checkIfDurationIsUnderTime(originalFile, durationUnder):
            return result(False, "", "The video is longer than the processing limit.")

    fixPrint(f"Args{randomSel}: {strArgs(args)}")

    UUID = ''.join(randChoice(ascii_letters) for i in range(10))
    originalFileName = getName(originalFile)
    originalFileExt  = getExt (originalFile)
    newFileDir       = f"{workingDir}/{UUID}_{originalFileName}"
    newFileHead      = f"{originalFileName}.{originalFileExt}"
    currentFilePath  = f"{newFileDir}/{newFileHead}"
    success = False
    try:
        makedirs(newFileDir)
        
        file_manipulation = copyfile if keepExtraFiles else rename
        file_manipulation(originalFile, currentFilePath)
        
        i = 0
        while True:
            newFilePath = f"{getDir(currentFilePath)}/0_{i}_{getName(currentFilePath)}.{getExt(currentFilePath)}"
            rename(currentFilePath, newFilePath)

            if i == len(args):
                currentFilePath = newFilePath
                break

            currentFilePath = edit(
                file            = newFilePath,
                groupData       = args[i],
                par             = par,
                workingDir      = workingDir,
                resourceDir     = resourceDir,
                SHOW_TIMER      = SHOW_TIMER,
                HIDE_FFMPEG_OUT = HIDE_FFMPEG_OUT,
                HIDE_ALL_FFMPEG = HIDE_ALL_FFMPEG,
                fixPrint        = fixPrint,
                **kwargs
            )
            i += 1

        final_name = f"{workingDir}/{getName(currentFilePath)}.{getExt(currentFilePath)}"
        rename(currentFilePath, final_name)
        
        if not keepExtraFiles: tryToDeleteDir(newFileDir)
        
        return result(True, final_name, "")
    except Exception as ex:
        fixPrint("Error! Args were:", strArgs(args))
        printEx(ex)

        if not keepExtraFiles:
            tryToDeleteFile(originalFile)
            tryToDeleteDir(newFileDir)
            
        return result(False, "", "An unknown error has occured!")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python videoEdit.py <args> <file> [workingDir] [resourceDir]", file=sys.stderr)
        sys.exit(1)
    args         = sys.argv[1]
    originalFile = sys.argv[2]
    workingDir   = sys.argv[3] if len(sys.argv) > 3 else path.dirname(path.abspath(originalFile))
    resourceDir  = sys.argv[4] if len(sys.argv) > 4 else path.join(path.dirname(path.abspath(__file__)), "assets")
    if not path.isfile(originalFile):
        print(f"Error! Cannot find input file: {originalFile}", file=sys.stderr)
        sys.exit(1)
    v = videoEdit(originalFile, args, workingDir=workingDir, resourceDir=resourceDir)
    if v.success:
        print(v.filename)
        sys.exit(0)
    else:
        print(v.message, file=sys.stderr)
        sys.exit(1)
