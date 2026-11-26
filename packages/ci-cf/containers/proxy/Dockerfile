FROM docker.io/cloudflare/proxy-everything@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8
COPY iptables-compat.sh /usr/local/sbin/iptables
RUN chmod 755 /usr/local/sbin/iptables && ln -s iptables /usr/local/sbin/ip6tables
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
