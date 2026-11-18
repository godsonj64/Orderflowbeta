import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignableRoles,
  canManageUser,
  canResetUserPassword,
  validateAdminPasswordInput,
} from './userManagement';

test('assignableRoles enforces role hierarchy for admin, owner, manager, and staff', () => {
  assert.deepEqual(assignableRoles('admin'), ['customer', 'driver', 'staff', 'manager', 'restaurant_owner', 'admin']);
  assert.deepEqual(assignableRoles('restaurant_owner'), ['customer', 'driver', 'staff', 'manager']);
  assert.deepEqual(assignableRoles('manager'), ['customer', 'driver', 'staff']);
  assert.deepEqual(assignableRoles('staff'), []);
  assert.deepEqual(assignableRoles('customer'), []);
});

test('canManageUser blocks self-removal, bootstrap admin removal, and higher-tier roles', () => {
  const staffMember = { uid: 'u_staff', email: 'cook@example.com', role: 'staff' as const };
  const managerUser = { uid: 'u_mgr', email: 'mgr@example.com', role: 'manager' as const };
  const ownerUser = { uid: 'u_own', email: 'owner@example.com', role: 'restaurant_owner' as const };
  const bootstrapAdmin = { uid: 'u_boot', email: 'godsonchristy25@gmail.com', role: 'admin' as const };

  // Self cannot be removed
  assert.equal(canManageUser('admin', 'u_staff', staffMember), false);
  // Bootstrap admin cannot be removed by anyone
  assert.equal(canManageUser('admin', 'u_other', bootstrapAdmin), false);

  // Admin can manage owners, managers, staff, drivers, customers
  assert.equal(canManageUser('admin', 'u_admin', ownerUser), true);
  assert.equal(canManageUser('admin', 'u_admin', managerUser), true);
  assert.equal(canManageUser('admin', 'u_admin', staffMember), true);

  // Restaurant owner can manage managers and below, but not other restaurant owners
  assert.equal(canManageUser('restaurant_owner', 'u_own', managerUser), true);
  assert.equal(canManageUser('restaurant_owner', 'u_own', staffMember), true);
  assert.equal(canManageUser('restaurant_owner', 'u_own2', ownerUser), false);

  // Manager can manage staff, drivers, customers, but not other managers or owners
  assert.equal(canManageUser('manager', 'u_mgr', staffMember), true);
  assert.equal(canManageUser('manager', 'u_mgr2', managerUser), false);
  assert.equal(canManageUser('manager', 'u_mgr', ownerUser), false);
});

test('canResetUserPassword allows password resets within role hierarchy', () => {
  const driverUser = { uid: 'u_drv', email: 'driver@example.com', role: 'driver' as const };
  const ownerUser = { uid: 'u_own', email: 'owner@example.com', role: 'restaurant_owner' as const };
  const bootstrapAdmin = { uid: 'u_boot', email: 'godsonj64@gmail.com', role: 'admin' as const };

  assert.equal(canResetUserPassword('manager', driverUser), true);
  assert.equal(canResetUserPassword('manager', ownerUser), false);
  assert.equal(canResetUserPassword('restaurant_owner', ownerUser), true);
  assert.equal(canResetUserPassword('restaurant_owner', bootstrapAdmin), false);
  assert.equal(canResetUserPassword('admin', bootstrapAdmin), true);
  assert.equal(canResetUserPassword('staff', driverUser), false);
});

test('validateAdminPasswordInput validates minimum and maximum password length', () => {
  assert.equal(validateAdminPasswordInput(''), 'Please enter a new password.');
  assert.equal(validateAdminPasswordInput('12345'), 'Password must be at least 6 characters.');
  assert.equal(validateAdminPasswordInput('secret123'), null);
});
