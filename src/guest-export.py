# Sail rejects absolute archive links, including Bun cache links back into the
# exported tree. Rebase those in a temporary copy; never edit the live session
# or follow links to files outside the requested directory.
import os
import shutil
import sys
import tempfile

source = os.path.abspath(sys.argv[1])
staging = tempfile.mkdtemp(prefix="longshot-export-")
tree = os.path.join(staging, "tree")
try:
    shutil.copytree(source, tree, symlinks=True)
    for directory, dirs, files in os.walk(tree, followlinks=False):
        for name in dirs + files:
            path = os.path.join(directory, name)
            if not os.path.islink(path):
                continue
            target = os.readlink(path)
            if not os.path.isabs(target):
                continue
            target = os.path.normpath(target)
            if os.path.commonpath([source, target]) != source:
                continue  # Keep external links intact so Sail still rejects them.
            local_target = os.path.join(tree, os.path.relpath(target, source))
            os.unlink(path)
            os.symlink(os.path.relpath(local_target, directory), path)
    print(staging)
except BaseException:
    shutil.rmtree(staging)
    raise
