// Lockers are 105-byte clones of one shared D17Locker. These checks cover what is new:
// the exact code of a clone, that its owner cannot be set or spoofed, that the shared code
// cannot be used on its own, and that the public interface did not change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { artifact, compile, eth, revertReason, root, setTime, startNode, waitForRpc, wait } from './helpers.mjs';
import { suite } from './release-fixture.mjs';

let checks = 0;
const check = (label, condition) => { checks++; assert.ok(condition, label); };
const rejects = async (label, call, expected) => {
  try { await call(); } catch (error) { check(label, revertReason(error) === expected); return; }
  assert.fail(`${label}: did not revert`);
};
const hex = address => address.slice(2).toLowerCase();

compile(); const child = startNode(9942); let p;
try {
  p = await waitForRpc(9942, child); const s = await suite(p);
  const abi = artifact('D17Locker.sol', 'D17Locker').abi;
  const user = await p.getSigner(2), stranger = await p.getSigner(9);
  const owner = await user.getAddress(), strangerAddress = await stranger.getAddress();
  const factory = await s.factory.getAddress(), weth = await s.weth.getAddress();
  const implementation = await s.lockerFactory.lockerImplementation();
  const stub = (lockerOwner) =>
    '0x363d3d373d3d3d363d73' + hex(implementation) + '5af43d82803e903d91602b57fd5bf3' + hex(lockerOwner) + hex(factory) + hex(weth);

  // A clone is the EIP-1167 stub followed by owner, factory and WETH, and nothing else.
  const address = await s.lockerFactory.connect(user).createLockerFor.staticCall(owner);
  const created = await wait(await s.lockerFactory.connect(user).createLockerFor(owner));
  const locker = new ethers.Contract(address, abi, user);
  check('clone code is exactly stub + owner + factory + weth', await p.getCode(address) === stub(owner));
  check('clone is 105 bytes', ethers.getBytes(await p.getCode(address)).length === 105);
  check('owner, factory and weth read back', await locker.owner() === owner && await locker.factory() === factory && await locker.weth() === weth);
  check('clone is registered', await s.factory.isLocker(address) && (await s.factory.lockersOfOwner(owner))[0] === address);
  check('creating a locker costs under 160,000 gas', created.gasUsed < 160_000n);
  await rejects('only the owner can create their locker', () => s.lockerFactory.connect(stranger).createLockerFor.staticCall(owner), 'ONLY_SELF');

  // Same public interface as the published V15.1 Locker, except that it has no constructor.
  const published = JSON.parse(readFileSync(path.join(root, 'abi', 'D17Locker.abi.json'), 'utf8'));
  const entries = list => list.filter(entry => entry.type !== 'constructor').map(entry => JSON.stringify(entry)).sort();
  check('ABI matches the published Locker ABI', JSON.stringify(entries(abi)) === JSON.stringify(entries(published)));
  check('no initializer or setter exists', !abi.some(entry => entry.type === 'function' && /^(init|set[A-Z]|transferOwner)/.test(entry.name)));

  // The shared code cannot be used directly, is not a locker and cannot be destroyed.
  const shared = new ethers.Contract(implementation, abi, stranger);
  check('shared code is not a registered locker', !(await s.factory.isLocker(implementation)));
  for (const getter of ['owner', 'factory', 'weth']) await rejects(`shared code has no ${getter}`, () => shared[getter](), 'NOT_A_LOCKER');
  const l = await s.launch(); await setTime(p, l.cfg.startTime + 1);
  await rejects('shared code cannot commit', () => shared.commitToRound.staticCall(l.address, 0, l.rules, { value: eth('1') }), 'NOT_A_LOCKER');
  for (const [method, args] of [
    ['refundCurrentRound', [l.address]], ['withdrawUnlockedWeth', [l.address, 1n]], ['refundFailedLaunch', [l.address, l.rules]],
    ['settleAndClaim', [l.address, l.rules]], ['withdrawUnlockedTokens', [l.address, 1n]], ['verifyLaunch', [l.address, l.rules]],
    ['recoverNativeEth', [strangerAddress, 1n]], ['recoverExcessWeth', [strangerAddress, 1n]],
  ]) await rejects(`shared code cannot ${method}`, () => shared[method].staticCall(...args), 'NOT_A_LOCKER');
  await rejects('shared code cannot settle', () => shared.settleAfterGrace.staticCall(l.address), 'UNKNOWN_LAUNCH');
  await rejects('shared code rejects ETH', () => stranger.call({ to: implementation, value: 1n }), 'DIRECT_ETH_REJECTED');
  const code = ethers.getBytes(await p.getCode(implementation)); const found = new Set();
  // The last two bytes give the length of the compiler's trailing metadata, which is not code.
  const metadataStart = code.length - 2 - (code[code.length - 2] << 8 | code[code.length - 1]);
  // The code ends at the first INVALID; constants (not code) may sit between it and the metadata.
  let codeEnd = 0;
  for (; codeEnd < metadataStart && code[codeEnd] !== 0xfe; codeEnd++) {
    const op = code[codeEnd];
    if (op >= 0x60 && op <= 0x7f) codeEnd += op - 0x5f; else found.add(op);
  }
  check('opcode scan saw the whole contract', metadataStart - codeEnd <= 128 && codeEnd > 7000 && found.has(0x3c) && found.has(0xf1));
  const runtime = artifact('D17Locker.sol', 'D17Locker'); let expected = runtime.deployedBytecode.slice(2);
  for (const refs of Object.values(runtime.immutableReferences)) for (const ref of refs)
    expected = expected.slice(0, ref.start * 2) + hex(implementation).padStart(ref.length * 2, '0') + expected.slice((ref.start + ref.length) * 2);
  check('shared code is the compiled D17Locker', (await p.getCode(implementation)).slice(2) === expected);
  check('shared code has empty storage', (await Promise.all([0, 1, 2].map(slot => p.getStorage(implementation, slot)))).every(value => BigInt(value) === 0n));
  check('shared code has no SELFDESTRUCT, DELEGATECALL or CALLCODE', ![0xff, 0xf4, 0xf2].some(op => found.has(op)));

  // The owner comes from the clone's code. Extra calldata cannot replace it.
  const forged = ethers.concat([strangerAddress, factory, weth]);
  const spoof = data => stranger.call({ to: address, data: ethers.concat([data, forged]) });
  check('appended calldata does not change owner()', ethers.AbiCoder.defaultAbiCoder().decode(['address'], await spoof(locker.interface.encodeFunctionData('owner')))[0] === owner);
  await rejects('appended calldata does not grant owner rights', () => spoof(locker.interface.encodeFunctionData('recoverNativeEth', [strangerAddress, 1n])), 'NOT_OWNER');
  await rejects('a stranger cannot commit through someone else\'s locker', () => locker.connect(stranger).commitToRound.staticCall(l.address, 0, l.rules, { value: eth('1') }), 'NOT_OWNER');

  // A look-alike clone deployed by a stranger runs the same code but no launch accepts it.
  const creation = '0x61' + '0069' + '3d81600a3d39f3' + stub(strangerAddress).slice(2);
  const fakeAddress = (await wait(await stranger.sendTransaction({ data: creation }))).contractAddress;
  const fake = new ethers.Contract(fakeAddress, abi, stranger);
  check('look-alike has the stranger as owner', await p.getCode(fakeAddress) === stub(strangerAddress) && await fake.owner() === strangerAddress);
  check('look-alike is not a registered locker', !(await s.factory.isLocker(fakeAddress)));
  await rejects('look-alike cannot be registered', () => s.factory.connect(stranger).registerLockerFor.staticCall(strangerAddress, fakeAddress), 'NOT_LOCKER_FACTORY');
  await rejects('launch refuses the look-alike', () => fake.commitToRound.staticCall(l.address, 0, l.rules, { value: eth('1') }), 'NOT_D17_LOCKER');

  // Even an exact copy of a real clone (same owner) is refused: registration is by address.
  const copyAddress = (await wait(await stranger.sendTransaction({ data: '0x61' + '0069' + '3d81600a3d39f3' + stub(owner).slice(2) }))).contractAddress;
  check('exact copy of a real clone is not a registered locker', await p.getCode(copyAddress) === await p.getCode(address) && !(await s.factory.isLocker(copyAddress)));
  await rejects('launch refuses the exact copy', () => new ethers.Contract(copyAddress, abi, user).commitToRound.staticCall(l.address, 0, l.rules, { value: eth('1') }), 'NOT_D17_LOCKER');

  // Each clone has its own storage; one owner may still hold several lockers.
  const secondAddress = await s.lockerFactory.connect(user).createLockerFor.staticCall(owner);
  await wait(await s.lockerFactory.connect(user).createLockerFor(owner));
  const second = new ethers.Contract(secondAddress, abi, user);
  check('a second locker for the same owner is a new registered clone', secondAddress !== address && await s.factory.isLocker(secondAddress) && (await s.factory.lockersOfOwner(owner)).length === 2);
  await wait(await locker.commitToRound(l.address, 0, l.rules, { value: eth('1') }));
  await wait(await second.commitToRound(l.address, 0, l.rules, { value: eth('2') }));
  // Trailing calldata from the owner is ignored, as it was before.
  await wait(await user.sendTransaction({ to: address, value: eth('0.5'), data: ethers.concat([locker.interface.encodeFunctionData('commitToRound', [l.address, 0, l.rules]), forged]) }));
  check('each clone keeps its own ledger', await locker.accountedWeth() === eth('1.5') && await second.accountedWeth() === eth('2') && await locker.lockedWeth(l.address) === eth('1.5'));
  check('each clone holds its own WETH', await s.weth.balanceOf(address) === eth('1.5') && await s.weth.balanceOf(secondAddress) === eth('2'));
  check('shared code holds nothing', await shared.accountedWeth() === 0n && await s.weth.balanceOf(implementation) === 0n && await p.getBalance(implementation) === 0n);
  await rejects('clone rejects direct ETH', () => user.call({ to: address, value: 1n }), 'DIRECT_ETH_REJECTED');
  await rejects('clone rejects unknown calls', () => user.call({ to: address, data: '0xdeadbeef' }), 'UNSUPPORTED_CALL');

  console.log(`locker-clone: ${checks} checks passed`);
} finally {
  child.kill();
}
