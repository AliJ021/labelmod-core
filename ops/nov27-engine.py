import gzip, hashlib, os, subprocess, sys
from pathlib import Path
from email.parser import Parser
packages = [Parser().parsestr(x) for x in gzip.decompress(Path("Packages.gz").read_bytes()).decode().split("\n\n") if x.strip()]
# Pinned to the versions in the official Docker noble stable index on release day.
targets = {"docker-ce":"5:29.10.1-1~ubuntu.24.04~noble","docker-ce-cli":"5:29.10.1-1~ubuntu.24.04~noble",
 "docker-ce-rootless-extras":"5:29.10.1-1~ubuntu.24.04~noble","containerd.io":"2.4.2-4~ubuntu.24.04~noble",
 "docker-compose-plugin":"5.8.0-1~ubuntu.24.04~noble","docker-buildx-plugin":"0.39.1-1~ubuntu.24.04~noble"}
for name,version in targets.items():
 q=subprocess.run(["dpkg-query","-W","-f=${db:Status-Abbrev} ${Version}",name],capture_output=True,text=True)
 if q.returncode or not q.stdout.startswith("ii "): continue
 installed=q.stdout.split()[-1]
 if subprocess.run(["dpkg","--compare-versions",version,"lt",installed]).returncode==0: sys.exit("Target is older than installed package")
 for folder,v in [("current",installed),("next",version)]:
  rows=[r for r in packages if r["Package"]==name and r["Version"]==v and r["Architecture"]=="amd64"]
  if len(rows)!=1: sys.exit("Signed index does not contain "+name+" "+v)
  r=rows[0]; target=Path(folder)/(name+".deb")
  if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest()!=r["SHA256"]:
   relative=r["Filename"]
   assert relative.startswith("dists/noble/pool/stable/amd64/") and ".." not in relative
   tmp=target.with_suffix(".part")
   subprocess.run(["curl","--proto","=https","--proto-redir","=https","-fLsS","--connect-timeout","10","--max-time","180","--retry","1","-o",str(tmp),os.environ["source"]+"/"+relative],check=True)
   if hashlib.sha256(tmp.read_bytes()).hexdigest()!=r["SHA256"]:sys.exit("Package checksum failed")
   tmp.replace(target)
 print(name,installed,"->",version,flush=True)
assert Path("next/docker-ce.deb").is_file() and Path("current/docker-ce.deb").is_file()
