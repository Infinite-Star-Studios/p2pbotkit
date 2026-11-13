# Saturn P2P bot kit in a container: for Railway (docs/RAILWAY.md) or any Docker host.
#
# The image holds the kit and its packages, and no key: the bots' keys and state live on a volume
# mounted at /data, which docker/entrypoint.sh links into the kit's folder before it runs start.sh.

# The Node that start.sh names (KIT_NODE_VERSION), on Debian: start.sh needs glibc, not Alpine's musl.
ARG NODE_IMAGE=node:22.23.5-bookworm-slim
FROM ${NODE_IMAGE}

# procps: ps, which start.sh uses to see that a bot has exited, and pkill, to stop a bot from a
# shell. tini: the image's first process, which passes SIGTERM on to start.sh and the bots, so a
# stop is their clean stop (-s: also where the platform runs an init of its own before it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# The packages, installed by start.sh itself: npm ci --ignore-scripts, exactly the versions in
# package-lock.json, with its own mark in node_modules, so a start in the container installs nothing.
# "market --help" sets up Node and the packages and prints the bot's help; it makes no key and no state,
# and the build stops if it ever did.
RUN KIT_NO_NODE_DOWNLOAD=1 sh start.sh market --help >/dev/null \
 && test -f node_modules/.kit-installed \
 && test ! -e keys && test ! -e data && test ! -e market.mainnet.json \
 && rm -rf /root/.npm

# The image's Node is the kit's own: never download another one into a container.
ENV KIT_NO_NODE_DOWNLOAD=1

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "sh", "/app/docker/entrypoint.sh"]
