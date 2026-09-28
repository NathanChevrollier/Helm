#!/bin/sh
set -e
/usr/sbin/virtlogd -d
/usr/sbin/libvirtd -d
sleep 2
virsh -c qemu:///system net-start default 2>/dev/null || true
if ! virsh -c qemu:///system dominfo cirros-test >/dev/null 2>&1; then
  virt_xml() {
    cat <<EOF
<domain type='qemu'>
  <name>$1</name>
  <memory unit='MiB'>128</memory>
  <vcpu>1</vcpu>
  <os><type arch='x86_64'>hvm</type><boot dev='hd'/></os>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/var/lib/libvirt/images/$1.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='network'><source network='default'/><model type='virtio'/></interface>
    <serial type='pty'/><console type='pty'/>
    <graphics type='$2' autoport='yes' listen='127.0.0.1'/>
  </devices>
</domain>
EOF
  }
  for vm in cirros-test spice-test; do
    qemu-img create -q -f qcow2 -F qcow2 -b /var/lib/libvirt/images/cirros.qcow2 /var/lib/libvirt/images/$vm.qcow2
  done
  virt_xml cirros-test vnc > /tmp/a.xml && virsh -c qemu:///system define /tmp/a.xml
  virt_xml spice-test spice > /tmp/b.xml && virsh -c qemu:///system define /tmp/b.xml
fi
exec /usr/sbin/sshd -D -e
